/**
 * The single best-effort sink for LLM-call telemetry. `recordLlmCall` is the
 * one entry point every instrumented LLM path uses (the Claude runner, the
 * OpenAI extractor/embedder/consolidator). It:
 *   1. forwards to the in-memory Prometheus registry (recordLlmMetric), and
 *   2. writes one durable `llm_calls` row, correlated by the active trace id.
 *
 * Contract: it NEVER throws. A reply or a fire-and-forget extraction must never
 * fail because telemetry recording failed. The durable write is additionally
 * gated on {@link isDbOpen} so it never auto-opens a database — in production
 * `main()` opens the DB at startup, so the sink is live by the time any LLM
 * call happens; in tests an un-opened DB simply skips the durable row.
 *
 * The Claude CLI runs as a subprocess, so its internal tool calls are opaque:
 * the `reply` row is one aggregate span for the whole invocation.
 */

import { randomUUID } from "node:crypto";
import { getDb, isDbOpen } from "../state/db.js";
import { currentTrace } from "./traceContext.js";
import { recordLlmMetric } from "../metrics/registry.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("trace-store");

export interface LlmCallRecord {
  provider: "anthropic" | "openai";
  model: string;
  operation: "reply" | "extract" | "consolidate" | "embed" | "summary";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  /** Defaults to "ok". */
  status?: "ok" | "error";
  /** Coarse failure class, e.g. http|timeout|parse|network|subprocess. */
  errorKind?: string;
  /** Anthropic reply only — agent turn count. */
  numTurns?: number;
}

// Latched off after the first durable-write failure so a missing/broken DB
// can't be hammered (and re-logged) on every subsequent LLM call.
let _dbSinkDisabled = false;

/** Test hook: re-enable the durable sink after a forced-failure test. */
export function __resetTraceStoreForTests(): void {
  _dbSinkDisabled = false;
}

/** Record one LLM call to the metrics registry + the durable trace table. */
export function recordLlmCall(rec: LlmCallRecord): void {
  const status = rec.status ?? "ok";

  // 1) In-memory metrics — cheap, no IO; attempt regardless of DB state.
  try {
    recordLlmMetric({
      provider: rec.provider,
      model: rec.model,
      operation: rec.operation,
      status,
      inputTokens: rec.inputTokens,
      outputTokens: rec.outputTokens,
      costUsd: rec.costUsd,
      latencyMs: rec.latencyMs,
    });
  } catch {
    /* metrics must never break a reply */
  }

  // 2) Durable row — only when the app DB is already live; best-effort.
  if (_dbSinkDisabled || !isDbOpen()) return;
  try {
    const trace = currentTrace();
    getDb()
      .prepare(
        `INSERT INTO llm_calls
           (call_id, trace_id, provider, model, operation, input_tokens, output_tokens,
            cost_usd, latency_ms, status, error_kind, num_turns, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        randomUUID(),
        trace?.traceId ?? "untraced",
        rec.provider,
        rec.model,
        rec.operation,
        rec.inputTokens ?? null,
        rec.outputTokens ?? null,
        rec.costUsd ?? null,
        rec.latencyMs ?? null,
        status,
        rec.errorKind ?? null,
        rec.numTurns ?? null,
        trace?.userId ?? null,
        new Date().toISOString()
      );
  } catch (err) {
    _dbSinkDisabled = true;
    log.warn({ err }, "llm_calls sink disabled after write failure (non-fatal)");
  }
}
