/**
 * Background ingestion of designated Slack channels into organizational memory.
 *
 * CHANNEL ALLOWLIST (security-critical): only channels listed in
 * MEMORY_SLACK_CHANNELS are ever read — Slack content is untrusted multi-author
 * input, so the default (empty) ingests NOTHING. Bot/automated messages and
 * near-empty chatter are skipped. Survivors run through the SAME hardened
 * extractor as every other source (prompt-as-data, evidence check, secret
 * filter), and facts are capped at a low confidence prior.
 *
 * Facts use source_type 'conversation' (Slack messages are conversational) with
 * a `slack:<channel>:<ts>` sourceRef so per-thread redaction (memory_forget_source)
 * still works — avoiding a risky rebuild of the FTS-backed memories table just
 * to add an enum value.
 *
 * Restart safety mirrors gmailIngest: a per-channel Postgres cursor
 * (`ingest_cursors.slack:<channel>` = last-processed ts) plus per-message dedup
 * (`ingested_docs`, `slack:<channel>:<ts>`). Oldest-first processing means the
 * cursor only advances over fully-processed messages; extraction-cap deferrals
 * stay unmarked and ahead of the cursor.
 */

import { getPool } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import { extractFacts } from "./extractor.js";
import { insertFact } from "./memoryStore.js";
import { getCursor, setCursor, markIngested, isIngested } from "./memorySql.js";

const log = createLogger("slack-ingest");

/** Max channels processed per tick. */
export const MAX_CHANNELS_PER_TICK = 5;
/** Max LLM extractions per tick across all channels (cost guard). */
export const MAX_EXTRACTIONS_PER_TICK = 10;
/** Messages shorter than this carry nothing durable. */
export const MIN_MESSAGE_CHARS = 80;
/** Slack-channel facts cap at this confidence prior (noisy, multi-author). */
export const SLACK_CONFIDENCE_CAP = 0.5;
/** Max messages pulled per channel per tick. */
export const HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** The channel allowlist from MEMORY_SLACK_CHANNELS (comma-separated ids). */
export function resolveIngestChannels(
  env: Record<string, string | undefined> = process.env
): string[] {
  const out: string[] = [];
  for (const raw of (env.MEMORY_SLACK_CHANNELS ?? "").split(",")) {
    const id = raw.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface SlackHistoryMessage {
  ts: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
}

export interface IngestDecision {
  ingest: boolean;
  reason?: string;
}

/**
 * Pure ingest gate for one Slack message. Bot/automated messages (no human
 * `user`, a `bot_id`, or a `bot_message` subtype) are rejected — they can echo
 * external/injected content. Near-empty chatter is skipped.
 */
export function shouldIngestSlackMessage(m: SlackHistoryMessage): IngestDecision {
  if (m.bot_id || m.subtype === "bot_message" || !m.user) {
    return { ingest: false, reason: "bot-or-automated" };
  }
  if (m.subtype && m.subtype !== "thread_broadcast") {
    // join/leave/topic/etc. system messages carry no durable facts.
    return { ingest: false, reason: `subtype:${m.subtype}` };
  }
  if (!m.text || m.text.trim().length < MIN_MESSAGE_CHARS) {
    return { ingest: false, reason: "short" };
  }
  return { ingest: true };
}

// ---------------------------------------------------------------------------
// Slack client surface (injectable; the watcher adapts @slack/web-api)
// ---------------------------------------------------------------------------

export interface SlackIngestClient {
  /** Messages in `channelId` strictly newer than `oldestTs` (oldest-first). */
  fetchHistory(
    channelId: string,
    oldestTs: string | undefined,
    limit: number
  ): Promise<SlackHistoryMessage[]>;
}

export interface SlackIngestDeps {
  slack: SlackIngestClient;
  apiKey: string;
  /** Allowlisted channel ids (already resolved). */
  channels: string[];
  now?: () => Date;
  fetchImpl?: typeof fetch;
}

const tsNum = (ts: string): number => {
  const n = Number(ts);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------

export async function runSlackIngest(deps: SlackIngestDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const nowMs = now.getTime();
  const pool = getPool();

  let extractions = 0;
  const channels = deps.channels.slice(0, MAX_CHANNELS_PER_TICK);

  for (const channelId of channels) {
    const cursorSource = `slack:${channelId}`;
    const cursor = (await getCursor(pool, cursorSource)) ?? undefined;

    let messages: SlackHistoryMessage[];
    try {
      messages = await deps.slack.fetchHistory(channelId, cursor, HISTORY_LIMIT);
    } catch (err) {
      log.error({ err, channelId }, "Slack history fetch failed — skipping channel this tick");
      continue;
    }
    messages.sort((a, b) => tsNum(a.ts) - tsNum(b.ts)); // oldest-first

    let maxProcessed = cursor ? tsNum(cursor) : 0;
    let deferred = false;

    for (const msg of messages) {
      const docId = `${cursorSource}:${msg.ts}`;
      if (await isIngested(pool, docId)) continue;

      const decision = shouldIngestSlackMessage(msg);
      if (!decision.ingest) {
        await markIngested(pool, docId, nowMs);
        maxProcessed = Math.max(maxProcessed, tsNum(msg.ts));
        continue;
      }

      if (extractions >= MAX_EXTRACTIONS_PER_TICK) {
        // Deferred: leave UNMARKED and behind the cursor so a later tick re-lists it.
        deferred = true;
        break;
      }

      const date = new Date(tsNum(msg.ts) * 1000).toISOString().slice(0, 10);
      const sourceLabel = `Slack #${channelId} (${date})`;
      const facts = await extractFacts({
        sourceType: "conversation",
        sourceLabel,
        content: msg.text ?? "",
        apiKey: deps.apiKey,
        fetchImpl: deps.fetchImpl,
      });
      extractions++;

      for (const fact of facts) {
        await insertFact({
          text: fact.text,
          category: fact.category,
          entities: fact.entities,
          sourceType: "conversation",
          sourceRef: docId,
          sourceLabel,
          assertedAt: new Date(tsNum(msg.ts) * 1000).toISOString(),
          evidenceQuote: fact.evidence_quote,
          confidence: Math.min(fact.confidence, SLACK_CONFIDENCE_CAP),
          sensitivity: fact.sensitivity,
          now,
        });
      }
      if (facts.length > 0) {
        log.info({ channelId, ts: msg.ts, count: facts.length }, "Stored Slack facts");
      }

      await markIngested(pool, docId, nowMs);
      maxProcessed = Math.max(maxProcessed, tsNum(msg.ts));
    }

    // Advance the cursor only over fully-processed messages. If we deferred,
    // maxProcessed already excludes the deferred (and later) messages.
    if (maxProcessed > (cursor ? tsNum(cursor) : 0)) {
      await setCursor(pool, cursorSource, String(maxProcessed), now);
    }
    if (deferred) {
      log.info({ channelId }, "Extraction cap reached — deferring remaining Slack messages");
      break;
    }
  }
}
