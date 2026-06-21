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

// Concurrency cap for detached joiner subprocesses.
//
// Default is 1 because all joiners share ONE signed-in persistent Chrome
// profile (data/sentinel-chrome-profile) and the joiner's cleanProfileLocks()
// deletes LOCK/Singleton* files on launch — two simultaneous Chrome instances
// on that profile would corrupt each other. Overridable via the
// MAX_CONCURRENT_JOINERS env var only if the profile constraint is lifted.
const DEFAULT_MAX_CONCURRENT_JOINERS = 1;

/**
 * Reads the concurrency cap from `MAX_CONCURRENT_JOINERS`, falling back to 1.
 * Read on every `runOnce` so the env var can be tuned without a rebuild; an
 * unset/blank/non-positive/NaN value falls back to the safe default.
 */
function maxConcurrentJoiners(): number {
  const raw = process.env.MAX_CONCURRENT_JOINERS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_CONCURRENT_JOINERS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_CONCURRENT_JOINERS;
}

// Number of joiner subprocesses currently alive. Incremented in spawnJoiner
// right before spawn() and decremented on the child's "exit" event. The child
// is detached/unref()'d, but unref only stops it from keeping the event loop
// alive — we can still observe "exit" while this process is running.
let activeJoiners = 0;

/**
 * Pure predicate: may we spawn another joiner given the current active count
 * and the cap? Exported so the backpressure rule can be unit-tested without
 * touching the calendar/spawn machinery.
 */
export function canSpawnJoiner(activeCount: number, cap: number): boolean {
  return activeCount < cap;
}

/** Current number of active (spawned, not-yet-exited) joiner subprocesses. */
export function activeJoinerCount(): number {
  return activeJoiners;
}

/** Test helper: resets the active-joiner counter. */
export function resetActiveJoinerCount(): void {
  activeJoiners = 0;
}

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
    await purgeOldJoinedIds(nowMs);

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
    const joinedIds = await getJoinedIds(nowMs - JOINED_TTL_MS);
    const toJoin = filterEventsToJoin(events, nowMs, joinedIds);

    if (toJoin.length === 0) return;

    const cap = maxConcurrentJoiners();

    for (const item of toJoin) {
      // Backpressure: never exceed the cap. The check is BEFORE markJoined so a
      // deferred event stays un-marked and is retried on the next poll once a
      // joiner slot frees (a child "exit" decrements activeJoiners). Joiners
      // share one signed-in Chrome profile, so the default cap of 1 prevents
      // two concurrent Chrome instances from corrupting each other's profile.
      if (!canSpawnJoiner(activeJoiners, cap)) {
        log.info(
          {
            eventId: item.event.id,
            summary: item.event.summary,
            meetUrl: item.meetUrl,
            activeJoiners,
            cap,
          },
          `joiner cap reached, deferring meeting ${item.event.id}`
        );
        continue;
      }

      log.info(
        {
          eventId: item.event.id,
          summary: item.event.summary,
          meetUrl: item.meetUrl,
          durationSec: item.durationSec,
        },
        "Launching bot for upcoming meeting"
      );

      await markJoined(item.event.id, nowMs);
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
    // PR #17 (revert e53eb54): production always hardcodes stay-until-end. This
    // intentionally overrides the joiner CLI's leave-after-join default (see
    // modeDispatch.ts) so the live bot stays for the full call. Docs-only change
    // would never touch this line; the value is load-bearing production behavior.
    stayMode: "stay-until-end",
  });

  // Pipe joiner's stdout/stderr to a per-spawn log file so failures are debuggable
  mkdirSync(JOINER_LOG_DIR, { recursive: true });
  const logPath = join(
    JOINER_LOG_DIR,
    `joiner-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
  );
  const logFd = openSync(logPath, "a");

  // Count this joiner as active right before spawning so an overlapping
  // runOnce sees the slot taken. Decremented when the child exits below.
  activeJoiners++;

  const child = spawn(command, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // The joiner authenticates via the persistent Chrome profile, not env vars.
    // Pass only a minimal non-secret runtime env so we don't leak app secrets
    // (Slack/OpenAI/Metabase/GitHub/Notion/Google) into a detached process.
    env: buildJoinerEnv(),
  });

  // Free the concurrency slot when the joiner exits. The listener is attached
  // before unref() — unref only stops the child from keeping the event loop
  // alive, it does not detach our "exit" handler while this process runs.
  child.on("exit", () => {
    activeJoiners = Math.max(0, activeJoiners - 1);
    log.info({ meetUrl, activeJoiners }, "Joiner exited, slot freed");
  });

  child.on("error", (err) => {
    log.error({ err, meetUrl, logPath }, "Failed to spawn joiner");
  });

  // Detach so bot continues even if Sentinel restarts
  child.unref();

  log.info(
    { meetUrl, pid: child.pid, logPath, activeJoiners },
    "Joiner spawned"
  );
}

/**
 * Removes persisted join-dedup rows older than the 4h TTL. Exported (with an
 * optional `nowMs` for deterministic testing) so the purge can be driven
 * without real time.
 */
export async function purgeOldJoinedIds(nowMs: number = Date.now()): Promise<void> {
  await purgeJoined(nowMs - JOINED_TTL_MS);
}
