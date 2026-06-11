/**
 * Memory ingestion poll loop (meet-bot watcher.ts pattern): every 5 minutes,
 * pull Meet transcripts and recent internal Gmail through the extraction
 * pipeline. Gated on the Google credentials AND ANTHROPIC_API_KEY — without
 * either it warns and returns a no-op stop, exactly like the Meet watcher.
 *
 * Kill switches (MAX_CONCURRENT_JOINERS precedent — read straight from the
 * env on every tick, no config.ts change, so they can be flipped without a
 * rebuild): MEMORY_INGEST_MEET=0 / MEMORY_INGEST_GMAIL=0 disable one source.
 *
 * Each source runs in its own try/catch so one failing can never block the
 * other, and an overlapping-tick guard skips a tick while the previous one is
 * still running (LLM calls can be slow).
 */

import { google } from "googleapis";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { createMeetClient } from "../google/meetClient.js";
import { runMeetIngest } from "./meetIngest.js";
import { runGmailIngest, resolveInternalDomains } from "./gmailIngest.js";

const log = createLogger("ingest-watcher");

export const INGEST_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/**
 * Start the ingestion poll loop. Returns a `stop()` function that clears the
 * interval; an in-flight tick is allowed to finish (it only writes SQLite).
 */
export function startIngestWatcher(): () => void {
  const hasGoogle =
    config.GOOGLE_CLIENT_ID &&
    config.GOOGLE_CLIENT_SECRET &&
    config.GOOGLE_REFRESH_TOKEN;

  if (!hasGoogle || !config.ANTHROPIC_API_KEY) {
    log.warn(
      "Google credentials or ANTHROPIC_API_KEY not set — memory ingest watcher disabled"
    );
    return () => {};
  }
  const apiKey = config.ANTHROPIC_API_KEY;

  // Build both clients once; tokens are refreshed/cached internally.
  const meetClient = createMeetClient({
    clientId: config.GOOGLE_CLIENT_ID!,
    clientSecret: config.GOOGLE_CLIENT_SECRET!,
    refreshToken: config.GOOGLE_REFRESH_TOKEN!,
  });

  const auth = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID!,
    config.GOOGLE_CLIENT_SECRET!
  );
  auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN! });
  const gmail = google.gmail({ version: "v1", auth });

  // Overlapping-tick guard: LLM-heavy ticks can outlast the interval.
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      log.warn("Previous ingest tick still running — skipping this tick");
      return;
    }
    running = true;
    try {
      // Sequential, each in its own try/catch: a Meet failure must not block
      // Gmail (and vice versa), and we never want both hitting the LLM budget
      // concurrently.
      if (process.env.MEMORY_INGEST_MEET === "0") {
        log.info("Meet ingestion disabled via MEMORY_INGEST_MEET=0");
      } else {
        try {
          await runMeetIngest({ meetClient, apiKey });
        } catch (err) {
          log.error({ err }, "Meet ingest tick failed");
        }
      }

      if (process.env.MEMORY_INGEST_GMAIL === "0") {
        log.info("Gmail ingestion disabled via MEMORY_INGEST_GMAIL=0");
      } else {
        try {
          await runGmailIngest({
            gmail,
            apiKey,
            internalDomains: resolveInternalDomains(),
          });
        } catch (err) {
          log.error({ err }, "Gmail ingest tick failed");
        }
      }
    } finally {
      running = false;
    }
  }

  log.info({ intervalMs: INGEST_INTERVAL_MS }, "Starting memory ingest watcher");

  // Fire once on startup, then on interval (watcher.ts pattern).
  void runOnce();
  const intervalId = setInterval(() => void runOnce(), INGEST_INTERVAL_MS);

  return function stop(): void {
    clearInterval(intervalId);
    log.info("Memory ingest watcher stopped");
  };
}
