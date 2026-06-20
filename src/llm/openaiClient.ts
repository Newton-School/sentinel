/**
 * OpenAI client for structured JSON extraction (fact extraction + dossier
 * consolidation). The same OpenAI key used for embeddings powers extraction here.
 *
 * Dependency-free (no openai SDK): transport reuses the existing
 * `fetchWithRetry` (timeout + bounded retry), errors are logged via
 * `redactedHttpError`, and the OpenAI key never leaks. Uses chat completions
 * with `response_format: json_object` (the extractor re-validates the shape
 * with Zod, so we don't depend on strict json_schema mode).
 *
 * Contract: `extractJson` NEVER throws to callers. Missing key, daily budget
 * exhausted, HTTP error, refusal, truncation, unparseable JSON → logs + null.
 */

import { config } from "../config.js";
import { fetchWithRetry } from "../mcp/httpRetry.js";
import { redactedHttpError } from "../mcp/httpError.js";
import { createLogger } from "../logging/logger.js";
import {
  recordMemoryExtractError,
  recordMemoryExtractBudgetExhausted,
} from "../metrics/registry.js";
import { recordLlmCall } from "./traceStore.js";
import { computeCostUsd } from "./modelPricing.js";

const log = createLogger("openai-client");

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
/** Default model for fact extraction (cheap, structured-output capable). */
export const OPENAI_EXTRACT_MODEL = "gpt-4o-mini";
/** Higher-quality model for consolidating high-value (root) entity dossiers. */
export const OPENAI_CONSOLIDATION_MODEL = "gpt-4o";
const DEFAULT_MAX_TOKENS = 1024;
const TIMEOUT_MS = 20_000;
const RETRIES = 2;

/** Hard daily cap on extraction calls (cost guard), keyed to the UTC date. */
export const MAX_EXTRACTION_CALLS_PER_DAY = 500;

/**
 * The OpenAI API key — shared with embeddings. Prefers OPENAI_API_KEY, falling
 * back to MEMORY_EMBEDDING_API_KEY so an existing embeddings-only config keeps
 * working.
 */
export function openaiApiKey(): string | undefined {
  return config.OPENAI_API_KEY ?? config.MEMORY_EMBEDDING_API_KEY;
}

// --- Daily budget (module-level, UTC-date keyed, injectable clock) ---------
//
// Counters are keyed by an opt-in bucket so independent call sites can't starve
// each other: fact extraction / consolidation / summaries share the default
// bucket (unchanged behaviour), while the analytics intent classifier passes
// its own bucket so heavy routing traffic can't exhaust the extraction budget.
// Every bucket gets the same daily cap; the UTC-day rollover resets all.

const DEFAULT_BUDGET_BUCKET = "default";
let budgetUtcDate = "";
const budgetCounts = new Map<string, number>();

/** Resets the daily-budget counters. Test hook only. */
export function __resetBudgetForTests(): void {
  budgetUtcDate = "";
  budgetCounts.clear();
}

function consumeBudget(nowMs: number, bucket: string = DEFAULT_BUDGET_BUCKET): boolean {
  const utcDate = new Date(nowMs).toISOString().slice(0, 10);
  if (utcDate !== budgetUtcDate) {
    budgetUtcDate = utcDate;
    budgetCounts.clear();
  }
  const used = budgetCounts.get(bucket) ?? 0;
  if (used >= MAX_EXTRACTION_CALLS_PER_DAY) return false;
  budgetCounts.set(bucket, used + 1);
  return true;
}

// --- Client -----------------------------------------------------------------

export interface ExtractJsonOptions {
  system: string;
  user: string;
  /** Plain JSON Schema object — appended to the system prompt as guidance. */
  schema: Record<string, unknown>;
  /** Model id override (defaults to OPENAI_EXTRACT_MODEL). */
  model?: string;
  /** Operation tag for the LLM trace row (defaults to "extract"). */
  operation?: "extract" | "consolidate" | "summary";
  /**
   * Daily-budget bucket. Call sites that should not compete with fact
   * extraction for the daily cap pass a distinct bucket (e.g. "classify").
   * Defaults to the shared bucket — unchanged behaviour for existing callers.
   */
  budgetBucket?: string;
  /** Versioned prompt id stamped onto the LLM trace row. */
  promptVersion?: string;
  /** Set false to skip the llm_calls trace row (e.g. the offline eval judge). */
  recordTrace?: boolean;
  maxTokens?: number;
  /** API key. Defaults to {@link openaiApiKey}; without one the call no-ops to null. */
  apiKey?: string;
  /** Injectable fetch for tests (threaded into fetchWithRetry). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the daily budget (defaults to Date.now). */
  now?: () => number;
}

interface ChatBody {
  model: string;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: Array<{ role: "system" | "user"; content: string }>;
}

function postBody(opts: ExtractJsonOptions): ChatBody {
  return {
    model: opts.model ?? OPENAI_EXTRACT_MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `${opts.system}\n\nReturn ONLY a single JSON object matching this schema, no prose:\n${JSON.stringify(opts.schema)}`,
      },
      { role: "user", content: opts.user },
    ],
  };
}

/**
 * Calls OpenAI chat completions and returns the parsed JSON object from the
 * first choice's message content, or `null` on ANY failure (never throws).
 */
export async function extractJson(opts: ExtractJsonOptions): Promise<unknown | null> {
  const apiKey = opts.apiKey ?? openaiApiKey();
  if (!apiKey) {
    log.warn("extractJson called without an OpenAI API key — skipping");
    return null;
  }

  const nowMs = (opts.now ?? Date.now)();
  if (!consumeBudget(nowMs, opts.budgetBucket)) {
    recordMemoryExtractBudgetExhausted();
    log.warn(
      { cap: MAX_EXTRACTION_CALLS_PER_DAY, utcDate: budgetUtcDate },
      "Daily extraction-call budget exhausted — skipping"
    );
    return null;
  }

  // Beyond this point an API call is actually attempted, so every exit records
  // one llm_calls span (provider=openai). The no-key/budget skips above are NOT
  // recorded — they are not calls.
  const model = opts.model ?? OPENAI_EXTRACT_MODEL;
  const operation = opts.operation ?? "extract";
  const startedAt = Date.now();
  const record = opts.recordTrace !== false;
  const reportError = (errorKind: string): void => {
    if (!record) return;
    recordLlmCall({
      provider: "openai",
      model,
      operation,
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorKind,
      promptVersion: opts.promptVersion,
    });
  };

  try {
    const res = await fetchWithRetry(
      OPENAI_CHAT_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(postBody(opts)),
      },
      { timeoutMs: TIMEOUT_MS, retries: RETRIES, fetchImpl: opts.fetchImpl }
    );

    if (!res.ok) {
      recordMemoryExtractError();
      reportError("http");
      log.warn(
        { message: redactedHttpError("OpenAI chat request failed", res).message },
        "extractJson HTTP failure"
      );
      return null;
    }

    const payload = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const choice = payload.choices?.[0];
    if (!choice || choice.message?.refusal || choice.finish_reason === "length") {
      recordMemoryExtractError();
      reportError("unusable");
      log.warn({ finishReason: choice?.finish_reason }, "extractJson unusable response");
      return null;
    }

    const content = choice.message?.content;
    if (typeof content !== "string") {
      recordMemoryExtractError();
      reportError("parse");
      log.warn("extractJson response had no message content");
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      recordMemoryExtractError();
      reportError("parse");
      log.warn({ err }, "extractJson content was not valid JSON");
      return null;
    }

    const inputTokens = payload.usage?.prompt_tokens;
    const outputTokens = payload.usage?.completion_tokens;
    if (record) {
      recordLlmCall({
        provider: "openai",
        model,
        operation,
        inputTokens,
        outputTokens,
        costUsd: computeCostUsd(model, inputTokens ?? 0, outputTokens ?? 0),
        latencyMs: Date.now() - startedAt,
        status: "ok",
        promptVersion: opts.promptVersion,
      });
    }
    return parsed;
  } catch (err) {
    recordMemoryExtractError();
    reportError("network");
    log.warn({ err }, "extractJson failed (non-fatal)");
    return null;
  }
}
