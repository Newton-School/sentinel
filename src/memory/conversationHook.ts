/**
 * Post-response hook: mines durable facts out of Sentinel's own Slack
 * conversations. Fire-and-forget by contract — `extractFromConversation`
 * returns immediately, the async work is detached, and NOTHING in here can
 * throw into (or slow down) the Slack reply path.
 *
 * Loop-breaker (user-turn grounding): the extraction CONTENT is the user's
 * `queryText` ONLY. The bot's own `responseText` is passed solely as fenced
 * disambiguation context inside the system prompt, and the extractor's
 * mechanical evidence check runs against the content — so a fact can only
 * survive if it is verbatim-grounded in what the USER said. Sentinel can
 * never launder its own (possibly memory-derived) replies back into memory.
 */

import { createLogger } from "../logging/logger.js";
import { recordMemoryExtractError } from "../metrics/registry.js";
import { extractFacts } from "./extractor.js";
import { openaiApiKey } from "../llm/openaiClient.js";
import { insertFact } from "./memoryStore.js";

const log = createLogger("conversation-hook");

/** Queries shorter than this carry nothing substantive to mine. */
const MIN_QUERY_CHARS = 40;

/** Max chars of the bot's reply forwarded as disambiguation context. */
const MAX_RESPONSE_CONTEXT_CHARS = 2000;

/** Conversation facts cap at this confidence prior (unverified chatter). */
const CONVERSATION_CONFIDENCE_CAP = 0.6;

export interface ConversationHookOptions {
  queryText: string;
  responseText: string;
  channelId: string;
  threadTs: string;
  /** Texts of the memories injected into this reply's system prompt. */
  injectedMemories: string[];
}

// Tracks the most recent detached run so tests can await completion
// deterministically. Production code never awaits it.
let inflight: Promise<void> = Promise.resolve();

/**
 * Fire-and-forget fact extraction from a completed Q&A exchange.
 * Never throws; never returns a promise for callers to await.
 */
export function extractFromConversation(opts: ConversationHookOptions): void {
  inflight = (async () => {
    const apiKey = openaiApiKey();
    if (!apiKey) return;
    if (opts.queryText.trim().length < MIN_QUERY_CHARS) return;

    const dateLabel = `Q&A ${new Date().toISOString().slice(0, 10)}`;
    const facts = await extractFacts({
      sourceType: "conversation",
      sourceLabel: dateLabel,
      content: opts.queryText,
      alreadyKnown: opts.injectedMemories,
      apiKey,
      disambiguationContext: opts.responseText.slice(
        0,
        MAX_RESPONSE_CONTEXT_CHARS
      ),
    });

    for (const fact of facts) {
      insertFact({
        text: fact.text,
        category: fact.category,
        entities: fact.entities,
        subject: fact.subject,
        sourceType: "conversation",
        sourceRef: `slack:${opts.channelId}:${opts.threadTs}`,
        sourceLabel: dateLabel,
        evidenceQuote: fact.evidence_quote,
        confidence: Math.min(fact.confidence, CONVERSATION_CONFIDENCE_CAP),
        sensitivity: fact.sensitivity,
      });
    }

    if (facts.length > 0) {
      log.info(
        { channelId: opts.channelId, threadTs: opts.threadTs, count: facts.length },
        "Stored conversation facts"
      );
    }
  })().catch((err) => {
    // LLM-call failures are already counted inside the OpenAI client (which
    // resolves null instead of throwing) — this catch counts the disjoint
    // pipeline failures (extractor throw, SQLite insert error), so no event
    // is double-counted.
    recordMemoryExtractError();
    log.error({ err }, "Conversation fact extraction failed (non-fatal)");
  });
}

export const __testing = {
  /** Awaits the most recent fire-and-forget run (deterministic tests). */
  flush: (): Promise<void> => inflight,
};
