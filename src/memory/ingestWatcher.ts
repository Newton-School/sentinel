/**
 * Memory ingestion poll loop (meet-bot watcher.ts pattern): every 5 minutes,
 * pull Meet transcripts, recent internal Gmail, and designated Slack channels
 * through the extraction pipeline. Requires an OpenAI key (extraction); the Google
 * sources additionally require the Google credentials, and Slack ingestion is
 * opt-in (see below). Starts only if at least one source is runnable.
 *
 * Kill switches (read straight from the env on every tick, no config.ts change,
 * so they can be flipped without a rebuild):
 *   - MEMORY_INGEST_MEET=0 / MEMORY_INGEST_GMAIL=0 disable a Google source.
 *   - MEMORY_INGEST_SLACK=1 ENABLES Slack-channel ingestion (OFF by default —
 *     Slack content is untrusted multi-author input); MEMORY_SLACK_CHANNELS is
 *     the channel allowlist (empty = nothing).
 *
 * Each source runs in its own try/catch so one failing can never block the
 * others, and an overlapping-tick guard skips a tick while the previous one is
 * still running (LLM calls can be slow).
 */

import { google } from "googleapis";
import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { createMeetClient } from "../google/meetClient.js";
import { runMeetIngest } from "./meetIngest.js";
import { runGmailIngest, resolveInternalDomains } from "./gmailIngest.js";
import { openaiApiKey } from "../llm/openaiClient.js";
import {
  runSlackIngest,
  resolveIngestChannels,
  type SlackIngestClient,
} from "./slackIngest.js";

const log = createLogger("ingest-watcher");

export const INGEST_INTERVAL_MS = 5 * 60 * 1000; // 5 min

/**
 * Start the ingestion poll loop. Returns a `stop()` function that clears the
 * interval; an in-flight tick is allowed to finish (it only writes SQLite).
 */
export function startIngestWatcher(): () => void {
  const hasGoogle = Boolean(
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN
  );
  const slackWanted = process.env.MEMORY_INGEST_SLACK === "1";

  const resolvedKey = openaiApiKey();
  if (!resolvedKey || (!hasGoogle && !slackWanted)) {
    log.warn(
      "No OpenAI key (extraction) or no ingestable source (Google creds / Slack) — ingest watcher disabled"
    );
    return () => {};
  }
  const apiKey: string = resolvedKey;

  // Google clients (Meet + Gmail) — built only when credentials are present.
  let meetClient: ReturnType<typeof createMeetClient> | null = null;
  let gmail: ReturnType<typeof google.gmail> | null = null;
  if (hasGoogle) {
    meetClient = createMeetClient({
      clientId: config.GOOGLE_CLIENT_ID!,
      clientSecret: config.GOOGLE_CLIENT_SECRET!,
      refreshToken: config.GOOGLE_REFRESH_TOKEN!,
    });
    const auth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID!, config.GOOGLE_CLIENT_SECRET!);
    auth.setCredentials({ refresh_token: config.GOOGLE_REFRESH_TOKEN! });
    gmail = google.gmail({ version: "v1", auth });
  }

  // Slack history client (bot token) — used only when MEMORY_INGEST_SLACK=1.
  const web = new WebClient(config.SLACK_BOT_TOKEN);
  const slackClient: SlackIngestClient = {
    async fetchHistory(channelId, oldestTs, limit) {
      const res = await web.conversations.history({
        channel: channelId,
        oldest: oldestTs,
        limit,
        inclusive: false,
      });
      return (res.messages ?? []).map((m) => ({
        ts: m.ts ?? "0",
        user: m.user,
        text: m.text,
        subtype: m.subtype,
        bot_id: m.bot_id,
      }));
    },
  };

  // Overlapping-tick guard: LLM-heavy ticks can outlast the interval.
  let running = false;

  async function runOnce(): Promise<void> {
    if (running) {
      log.warn("Previous ingest tick still running — skipping this tick");
      return;
    }
    running = true;
    try {
      // Sequential, each in its own try/catch so a failure in one source never
      // blocks another, and we never hit the LLM budget concurrently.
      if (hasGoogle && meetClient) {
        if (process.env.MEMORY_INGEST_MEET === "0") {
          log.info("Meet ingestion disabled via MEMORY_INGEST_MEET=0");
        } else {
          try {
            await runMeetIngest({ meetClient, apiKey });
          } catch (err) {
            log.error({ err }, "Meet ingest tick failed");
          }
        }
      }

      if (hasGoogle && gmail) {
        if (process.env.MEMORY_INGEST_GMAIL === "0") {
          log.info("Gmail ingestion disabled via MEMORY_INGEST_GMAIL=0");
        } else {
          try {
            await runGmailIngest({ gmail, apiKey, internalDomains: resolveInternalDomains() });
          } catch (err) {
            log.error({ err }, "Gmail ingest tick failed");
          }
        }
      }

      // Slack: opt-in + allowlist (default OFF / empty → nothing ingested).
      if (process.env.MEMORY_INGEST_SLACK === "1") {
        const channels = resolveIngestChannels();
        if (channels.length === 0) {
          log.info("MEMORY_INGEST_SLACK=1 but MEMORY_SLACK_CHANNELS empty — nothing to ingest");
        } else {
          try {
            await runSlackIngest({ slack: slackClient, apiKey, channels });
          } catch (err) {
            log.error({ err }, "Slack ingest tick failed");
          }
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
