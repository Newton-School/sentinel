/**
 * OpenAI embeddings client for hybrid retrieval. Dependency-free (reuses the
 * existing fetchWithRetry + redactedHttpError), and NEVER throws to callers:
 * missing key, daily budget exhausted, HTTP error, or a malformed response all
 * resolve to `null` (single) / `null`-filled (batch), so retrieval degrades to
 * BM25-only rather than failing.
 *
 * Privacy: callers must NOT pass sensitive fact text here (it would leave the
 * box for OpenAI) — the write path filters `sensitivity='sensitive'` out.
 *
 * Vectors are stored as little-endian Float32 BLOBs; cosine similarity is a
 * plain dot/‖a‖‖b‖ (robust whether or not the provider unit-normalizes).
 */

import { fetchWithRetry } from "../mcp/httpRetry.js";
import { redactedHttpError } from "../mcp/httpError.js";
import { createLogger } from "../logging/logger.js";
import { recordLlmCall } from "../llm/traceStore.js";
import { computeCostUsd } from "../llm/modelPricing.js";

const log = createLogger("embedder");

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_MODEL = "text-embedding-3-small";
const TIMEOUT_MS = 20_000;
const RETRIES = 2;

/** Hard daily cap on embedding REQUESTS (each may batch many inputs). */
export const MAX_EMBEDDING_CALLS_PER_DAY = 2000;

// --- Daily budget (module-level, UTC-date keyed, injectable clock) ----------
let budgetUtcDate = "";
let budgetCallsToday = 0;

/** Resets the daily-budget counter. Test hook only. */
export function __resetEmbeddingBudgetForTests(): void {
  budgetUtcDate = "";
  budgetCallsToday = 0;
}

function consumeBudget(nowMs: number): boolean {
  const utcDate = new Date(nowMs).toISOString().slice(0, 10);
  if (utcDate !== budgetUtcDate) {
    budgetUtcDate = utcDate;
    budgetCallsToday = 0;
  }
  if (budgetCallsToday >= MAX_EMBEDDING_CALLS_PER_DAY) return false;
  budgetCallsToday++;
  return true;
}

// --- Encoding + similarity --------------------------------------------------

/** Encodes a Float32Array as a little-endian Float32 BLOB. */
export function floatToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Decodes a Float32 BLOB back into a Float32Array (copying, alignment-safe). */
export function blobToFloat(b: Buffer): Float32Array {
  const copy = Buffer.from(b); // ensure 4-byte alignment + own the memory
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

/** Cosine similarity in [-1, 1]; 0 when either vector is zero/empty/mismatched. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// --- Client -----------------------------------------------------------------

export interface EmbedOptions {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Embeds a batch of texts in one request. Returns a parallel array of
 * Float32Array (or `null` for the whole batch on any failure). Empty input
 * returns `[]` without an API call.
 */
export async function embedTexts(
  texts: string[],
  opts: EmbedOptions
): Promise<Array<Float32Array | null>> {
  if (texts.length === 0) return [];
  if (!opts.apiKey) {
    log.warn("embedTexts called without an API key — skipping");
    return texts.map(() => null);
  }

  const nowMs = (opts.now ?? Date.now)();
  if (!consumeBudget(nowMs)) {
    log.warn(
      { cap: MAX_EMBEDDING_CALLS_PER_DAY, utcDate: budgetUtcDate },
      "Daily embedding-call budget exhausted — skipping"
    );
    return texts.map(() => null);
  }

  // An API call is attempted from here, so every exit records one llm_calls
  // span (one row per request, regardless of batch size).
  const model = opts.model ?? DEFAULT_MODEL;
  const startedAt = Date.now();
  const reportError = (errorKind: string): void => {
    recordLlmCall({
      provider: "openai",
      model,
      operation: "embed",
      latencyMs: Date.now() - startedAt,
      status: "error",
      errorKind,
    });
  };

  try {
    const res = await fetchWithRetry(
      OPENAI_EMBEDDINGS_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: texts }),
      },
      { timeoutMs: TIMEOUT_MS, retries: RETRIES, fetchImpl: opts.fetchImpl }
    );

    if (!res.ok) {
      log.warn(
        { message: redactedHttpError("Embeddings request failed", res).message },
        "embedTexts HTTP failure"
      );
      reportError("http");
      return texts.map(() => null);
    }

    const payload = (await res.json()) as EmbeddingsResponse;
    const data = payload.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      log.warn("embedTexts response shape unexpected — skipping");
      reportError("parse");
      return texts.map(() => null);
    }

    const promptTokens = payload.usage?.prompt_tokens;
    recordLlmCall({
      provider: "openai",
      model,
      operation: "embed",
      inputTokens: promptTokens,
      outputTokens: 0,
      costUsd: computeCostUsd(model, promptTokens ?? 0, 0),
      latencyMs: Date.now() - startedAt,
      status: "ok",
    });

    // Order by `index` defensively (the API returns them in input order).
    const out: Array<Float32Array | null> = texts.map(() => null);
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const idx = typeof item.index === "number" ? item.index : i;
      if (Array.isArray(item.embedding) && idx >= 0 && idx < out.length) {
        out[idx] = Float32Array.from(item.embedding);
      }
    }
    return out;
  } catch (err) {
    log.warn({ err }, "embedTexts failed (non-fatal)");
    reportError("network");
    return texts.map(() => null);
  }
}

/** Embeds a single text. Returns the vector or `null` on any failure. */
export async function embedText(
  text: string,
  opts: EmbedOptions
): Promise<Float32Array | null> {
  const [v] = await embedTexts([text], opts);
  return v ?? null;
}
