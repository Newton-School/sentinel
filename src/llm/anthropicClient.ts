/**
 * Dependency-free Anthropic Messages API client for structured JSON
 * extraction (claude-haiku-4-5). Deliberately NOT the @anthropic-ai/sdk —
 * Sentinel adds no new npm deps for this; transport reuses the existing
 * `fetchWithRetry` (timeout + bounded retry) and errors are logged via
 * `redactedHttpError` so upstream bodies never leak into logs.
 *
 * Contract: `extractJson` NEVER throws to callers. Every failure mode —
 * missing key, daily budget exhausted, HTTP error, refusal, truncation,
 * unparseable JSON — logs and resolves `null`.
 *
 * Structured outputs: the request asks for `output_config.format =
 * {type: "json_schema", schema}` so the model is constrained to the schema.
 * If the API rejects the request with HTTP 400 (e.g. an older API surface
 * that does not know `output_config`), we retry ONCE without it, appending a
 * JSON-only instruction (plus the serialized schema) to the system prompt and
 * parsing the text content with JSON.parse.
 */

import { fetchWithRetry } from "../mcp/httpRetry.js";
import { redactedHttpError } from "../mcp/httpError.js";
import { createLogger } from "../logging/logger.js";
// This client is used exclusively by the memory extraction pipeline, so its
// failure/budget counters are memory metrics. Increments happen here (the
// edge) rather than inside extractor.ts.
import {
  recordMemoryExtractError,
  recordMemoryExtractBudgetExhausted,
} from "../metrics/registry.js";

const log = createLogger("anthropic-client");

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
/** Default extraction model. */
export const HAIKU_MODEL = "claude-haiku-4-5";
/** Higher-quality model for consolidation of high-value (root) entities. */
export const SONNET_MODEL = "claude-sonnet-4-6";
const MODEL = HAIKU_MODEL;
const DEFAULT_MAX_TOKENS = 1024;
const TIMEOUT_MS = 20_000;
const RETRIES = 2;

/** Hard daily cap on extraction calls (cost guard), keyed to the UTC date. */
export const MAX_EXTRACTION_CALLS_PER_DAY = 500;

const JSON_ONLY_INSTRUCTION =
  "Respond with ONLY a single valid JSON object matching this schema, no prose:";

// --- Daily budget (module-level, UTC-date keyed, injectable clock) ---------

let budgetUtcDate = "";
let budgetCallsToday = 0;

/** Resets the daily-budget counter. Test hook only. */
export function __resetBudgetForTests(): void {
  budgetUtcDate = "";
  budgetCallsToday = 0;
}

/** Returns true when the call is within budget (and consumes one unit). */
function consumeBudget(nowMs: number): boolean {
  const utcDate = new Date(nowMs).toISOString().slice(0, 10);
  if (utcDate !== budgetUtcDate) {
    budgetUtcDate = utcDate;
    budgetCallsToday = 0;
  }
  if (budgetCallsToday >= MAX_EXTRACTION_CALLS_PER_DAY) {
    return false;
  }
  budgetCallsToday++;
  return true;
}

// --- Client -----------------------------------------------------------------

export interface ExtractJsonOptions {
  system: string;
  user: string;
  /** Plain JSON Schema object for structured outputs. */
  schema: Record<string, unknown>;
  /** Model id override (defaults to Haiku). Use SONNET_MODEL for richer synthesis. */
  model?: string;
  maxTokens?: number;
  /** API key. Without one the call is a logged no-op returning null. */
  apiKey?: string;
  /** Injectable fetch for tests (threaded into fetchWithRetry). */
  fetchImpl?: typeof fetch;
  /** Injectable clock for the daily budget (defaults to Date.now). */
  now?: () => number;
}

interface MessagesApiBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
  output_config?: { format: { type: "json_schema"; schema: Record<string, unknown> } };
}

function postBody(
  opts: ExtractJsonOptions,
  withStructuredOutput: boolean
): MessagesApiBody {
  const body: MessagesApiBody = {
    model: opts.model ?? MODEL,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    system: withStructuredOutput
      ? opts.system
      : `${opts.system}\n\n${JSON_ONLY_INSTRUCTION} ${JSON.stringify(opts.schema)}`,
    messages: [{ role: "user", content: opts.user }],
  };
  if (withStructuredOutput) {
    body.output_config = {
      format: { type: "json_schema", schema: opts.schema },
    };
  }
  return body;
}

function post(
  opts: ExtractJsonOptions,
  withStructuredOutput: boolean
): Promise<Response> {
  return fetchWithRetry(
    MESSAGES_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": opts.apiKey as string,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(postBody(opts, withStructuredOutput)),
    },
    { timeoutMs: TIMEOUT_MS, retries: RETRIES, fetchImpl: opts.fetchImpl }
  );
}

/**
 * Calls the Messages API and returns the parsed JSON object from the first
 * text content block, or `null` on ANY failure (never throws).
 */
export async function extractJson(
  opts: ExtractJsonOptions
): Promise<unknown | null> {
  if (!opts.apiKey) {
    log.warn("extractJson called without an API key — skipping");
    return null;
  }

  const nowMs = (opts.now ?? Date.now)();
  if (!consumeBudget(nowMs)) {
    recordMemoryExtractBudgetExhausted();
    log.warn(
      { cap: MAX_EXTRACTION_CALLS_PER_DAY, utcDate: budgetUtcDate },
      "Daily extraction-call budget exhausted — skipping"
    );
    return null;
  }

  try {
    let res = await post(opts, true);

    // 400 fallback: older API surfaces reject `output_config`. Retry exactly
    // once without it, demanding JSON-only output via the system prompt.
    if (res.status === 400) {
      log.warn("Messages API returned 400 — retrying once without output_config");
      res = await post(opts, false);
    }

    if (!res.ok) {
      recordMemoryExtractError();
      log.warn(
        { message: redactedHttpError("Messages API request failed", res).message },
        "extractJson HTTP failure"
      );
      return null;
    }

    const payload = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string;
    };

    if (payload.stop_reason === "refusal" || payload.stop_reason === "max_tokens") {
      recordMemoryExtractError();
      log.warn({ stopReason: payload.stop_reason }, "extractJson unusable stop_reason");
      return null;
    }

    const textBlock = payload.content?.find((b) => b.type === "text");
    if (!textBlock || typeof textBlock.text !== "string") {
      recordMemoryExtractError();
      log.warn("extractJson response had no text content block");
      return null;
    }

    return JSON.parse(textBlock.text) as unknown;
  } catch (err) {
    recordMemoryExtractError();
    log.warn({ err }, "extractJson failed (non-fatal)");
    return null;
  }
}
