import { spawn } from "node:child_process";
import { join } from "node:path";
import { openSync, mkdirSync } from "node:fs";
import { google } from "googleapis";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import {
  filterEventsToJoin,
  type CalendarEventLite,
} from "./eventFilter.js";

const log = createLogger("meet-watcher");

const POLL_INTERVAL_MS = 60 * 1000; // 1 min
const LOOK_AHEAD_MS = 5 * 60 * 1000; // fetch events starting in the next 5 min
const JOINED_TTL_MS = 4 * 60 * 60 * 1000; // purge joined-event memory after 4 hours

const JOINER_SCRIPT = join(process.cwd(), "dist", "meet-bot", "joiner.js");
const JOINER_SCRIPT_DEV = join(process.cwd(), "src", "meet-bot", "joiner.ts");
const JOINER_LOG_DIR = join(process.cwd(), "data", "meet-bot-logs");

// Track joined event IDs with a timestamp for TTL purging
const joinedAt = new Map<string, number>();

export function startMeetWatcher(): void {
  const hasGoogle =
    config.GOOGLE_CLIENT_ID &&
    config.GOOGLE_CLIENT_SECRET &&
    config.GOOGLE_REFRESH_TOKEN;

  if (!hasGoogle) {
    log.warn("Google credentials not set — Meet watcher disabled");
    return;
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
  setInterval(() => void runOnce(calendar), POLL_INTERVAL_MS);
}

async function runOnce(
  calendar: ReturnType<typeof google.calendar>
): Promise<void> {
  try {
    purgeOldJoinedIds();

    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + LOOK_AHEAD_MS).toISOString();

    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 25,
    });

    const rawEvents = res.data.items ?? [];
    const events: CalendarEventLite[] = rawEvents
      .filter((e): e is NonNullable<typeof e> & { id: string } => !!e.id)
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

    const joinedIds = new Set(joinedAt.keys());
    const toJoin = filterEventsToJoin(events, now.getTime(), joinedIds);

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

      joinedAt.set(item.event.id, Date.now());
      spawnJoiner(item.meetUrl, item.durationSec);
    }
  } catch (err) {
    log.error({ err }, "Meet watcher poll failed");
  }
}

function spawnJoiner(meetUrl: string, durationSec: number): void {
  // Prefer compiled dist in prod; fall back to tsx in dev
  const useTsx = process.env.NODE_ENV !== "production";
  const command = useTsx ? "npx" : "node";
  const stayModeArgs = ["--stay-mode", "stay-until-end"];
  const args = useTsx
    ? [
        "tsx",
        JOINER_SCRIPT_DEV,
        meetUrl,
        "--duration",
        String(durationSec),
        ...stayModeArgs,
      ]
    : [
        JOINER_SCRIPT,
        meetUrl,
        "--duration",
        String(durationSec),
        ...stayModeArgs,
      ];

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
    env: { ...process.env },
  });

  child.on("error", (err) => {
    log.error({ err, meetUrl, logPath }, "Failed to spawn joiner");
  });

  // Detach so bot continues even if Sentinel restarts
  child.unref();

  log.info({ meetUrl, pid: child.pid, logPath }, "Joiner spawned");
}

function purgeOldJoinedIds(): void {
  const cutoff = Date.now() - JOINED_TTL_MS;
  for (const [id, ts] of joinedAt.entries()) {
    if (ts < cutoff) joinedAt.delete(id);
  }
}
