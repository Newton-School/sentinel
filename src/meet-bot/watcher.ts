import { spawn } from "node:child_process";
import { join } from "node:path";
import { openSync, mkdirSync } from "node:fs";
import { google } from "googleapis";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { buildJoinerEnv } from "./joinerEnv.js";
import {
  filterEventsToJoin,
  type CalendarEventLite,
} from "./eventFilter.js";
import {
  markJoined,
  getJoinedIds,
  purgeJoined,
  clearJoined,
} from "./joinStore.js";

const log = createLogger("meet-watcher");

const POLL_INTERVAL_MS = 60 * 1000; // 1 min
const LOOK_AHEAD_MS = 5 * 60 * 1000; // fetch events starting in the next 5 min
const JOINED_TTL_MS = 4 * 60 * 60 * 1000; // purge joined-event memory after 4 hours

const JOINER_SCRIPT = join(process.cwd(), "dist", "meet-bot", "joiner.js");
const JOINER_SCRIPT_DEV = join(process.cwd(), "src", "meet-bot", "joiner.ts");
const JOINER_LOG_DIR = join(process.cwd(), "data", "meet-bot-logs");

// Joined event IDs are persisted in SQLite (joined_meetings table via
// joinStore) so dedup survives process restarts — previously this was an
// in-memory Map that was lost on restart, causing the watcher to re-join
// in-progress meetings and spawn a second Chromium.

/** Test helper: clears all persisted join-dedup rows. */
export function resetJoinedAt(): void {
  clearJoined();
}

/**
 * Start the Meet watcher poll loop.
 *
 * Returns a `stop()` function that clears the poll interval so no further
 * joiner subprocesses are spawned. Note: `stop()` does NOT terminate joiner
 * subprocesses that have already been spawned — they are detached/`unref()`'d
 * on purpose so the bot keeps running even if Sentinel restarts.
 */
export function startMeetWatcher(): () => void {
  const hasGoogle =
    config.GOOGLE_CLIENT_ID &&
    config.GOOGLE_CLIENT_SECRET &&
    config.GOOGLE_REFRESH_TOKEN;

  if (!hasGoogle) {
    log.warn("Google credentials not set — Meet watcher disabled");
    return () => {};
  }

  log.info({ intervalMs: POLL_INTERVAL_MS }, "Starting Meet watcher");

  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID!,
    config.GOOGLE_CLIENT_SECRET!
  );
  auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN! });
  const calendar = google.calendar({ version: "v3", auth });

  // Fire once on startup, then on interval
  void runOnce(calendar);
  const intervalId = setInterval(() => void runOnce(calendar), POLL_INTERVAL_MS);

  return function stop(): void {
    clearInterval(intervalId);
    log.info("Meet watcher poll loop stopped");
  };
}

/**
 * Raw Google Calendar event shape we read from. Kept loose (all fields
 * optional/nullable) to match the googleapis return type without coupling to it.
 */
interface RawCalendarEvent {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  hangoutLink?: string | null;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string | null;
      uri?: string | null;
    }> | null;
  } | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
}

/**
 * Maps raw Google Calendar events to the trimmed `CalendarEventLite` shape used
 * by `filterEventsToJoin`. Drops events with no `id` and coerces `null` → `undefined`.
 * Pure — exported for testing the watcher's event mapping in isolation.
 */
export function mapCalendarEvents(
  rawEvents: ReadonlyArray<RawCalendarEvent>
): CalendarEventLite[] {
  return rawEvents
    .filter((e): e is RawCalendarEvent & { id: string } => !!e.id)
    .map((e) => ({
      id: e.id,
      summary: e.summary ?? undefined,
      description: e.description ?? undefined,
      location: e.location ?? undefined,
      hangoutLink: e.hangoutLink ?? undefined,
      conferenceData: e.conferenceData
        ? {
            entryPoints: e.conferenceData.entryPoints?.map((ep) => ({
              entryPointType: ep.entryPointType ?? undefined,
              uri: ep.uri ?? undefined,
            })),
          }
        : undefined,
      start: {
        dateTime: e.start?.dateTime ?? undefined,
        date: e.start?.date ?? undefined,
      },
      end: {
        dateTime: e.end?.dateTime ?? undefined,
        date: e.end?.date ?? undefined,
      },
    }));
}

export async function runOnce(
  calendar: ReturnType<typeof google.calendar>
): Promise<void> {
  try {
    const nowMs = Date.now();
    purgeOldJoinedIds(nowMs);

    const now = new Date(nowMs);
    const timeMin = now.toISOString();
    const timeMax = new Date(nowMs + LOOK_AHEAD_MS).toISOString();

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
    });

    const events: CalendarEventLite[] = mapCalendarEvents(res.data.items ?? []);

    // Read the persisted joined set within the TTL window so dedup survives
    // restarts (rows older than the TTL were just purged above).
    const joinedIds = getJoinedIds(nowMs - JOINED_TTL_MS);
    const toJoin = filterEventsToJoin(events, nowMs, joinedIds);

    if (toJoin.length === 0) return;

    for (const item of toJoin) {
      log.info(
        {
          eventId: item.event.id,
          summary: item.event.summary,
          meetUrl: item.meetUrl,
          durationSec: item.durationSec,
        },
        "Launching bot for upcoming meeting"
      );

      markJoined(item.event.id, nowMs);
      spawnJoiner(item.meetUrl, item.durationSec);
    }
  } catch (err) {
    log.error({ err }, "Meet watcher poll failed");
  }
}

/** Options for building the joiner subprocess command + argument vector. */
export interface BuildJoinerArgsOptions {
  meetUrl: string;
  durationSec: number;
  /** True → dev path (`npx tsx`); false → prod path (`node`). */
  useTsx: boolean;
  /** Path to the TS joiner script (used on the dev/tsx path). */
  devScript: string;
  /** Path to the compiled JS joiner script (used on the prod/node path). */
  prodScript: string;
  /** Stay-mode flag value forwarded to the joiner. */
  stayMode: string;
}

/**
 * Builds the full argv (command first) for spawning the Meet joiner.
 *
 * Dev:  ["npx", "tsx", devScript, meetUrl, "--duration", "<sec>", "--stay-mode", "<mode>"]
 * Prod: ["node", prodScript, meetUrl, "--duration", "<sec>", "--stay-mode", "<mode>"]
 *
 * Pure — no process/env/fs access — so the exact argv can be asserted in tests.
 */
export function buildJoinerArgs(opts: BuildJoinerArgsOptions): string[] {
  const { meetUrl, durationSec, useTsx, devScript, prodScript, stayMode } = opts;
  const tail = [
    meetUrl,
    "--duration",
    String(durationSec),
    "--stay-mode",
    stayMode,
  ];
  return useTsx
    ? ["npx", "tsx", devScript, ...tail]
    : ["node", prodScript, ...tail];
}

function spawnJoiner(meetUrl: string, durationSec: number): void {
  // Prefer compiled dist in prod; fall back to tsx in dev
  const useTsx = process.env.NODE_ENV !== "production";
  const [command, ...args] = buildJoinerArgs({
    meetUrl,
    durationSec,
    useTsx,
    devScript: JOINER_SCRIPT_DEV,
    prodScript: JOINER_SCRIPT,
    // PR #17: the watcher always hardcodes stay-until-end.
    stayMode: "stay-until-end",
  });

  // Pipe joiner's stdout/stderr to a per-spawn log file so failures are debuggable
  mkdirSync(JOINER_LOG_DIR, { recursive: true });
  const logPath = join(
    JOINER_LOG_DIR,
    `joiner-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
  );
  const logFd = openSync(logPath, "a");

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // The joiner authenticates via the persistent Chrome profile, not env vars.
    // Pass only a minimal non-secret runtime env so we don't leak app secrets
    // (Slack/Anthropic/Metabase/GitHub/Notion/Google) into a detached process.
    env: buildJoinerEnv(),
  });

  child.on("error", (err) => {
    log.error({ err, meetUrl, logPath }, "Failed to spawn joiner");
  });

  // Detach so bot continues even if Sentinel restarts
  child.unref();

  log.info({ meetUrl, pid: child.pid, logPath }, "Joiner spawned");
}

/**
 * Removes persisted join-dedup rows older than the 4h TTL. Exported (with an
 * optional `nowMs` for deterministic testing) so the purge can be driven
 * without real time.
 */
export function purgeOldJoinedIds(nowMs: number = Date.now()): void {
  purgeJoined(nowMs - JOINED_TTL_MS);
}
