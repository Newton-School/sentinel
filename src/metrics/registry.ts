import type { SlackEventEnvelope } from "../types/contracts.js";

/**
 * In-process ops metrics for Sentinel requests.
 *
 * Side-effect-free and dependency-free: a module-scoped mutable counter set
 * that `record()` mutates and `snapshot()` / `renderPrometheus()` read. The
 * Prometheus text exposition format (v0.0.4) is hand-rolled — no client lib.
 *
 * NOTE: intentionally distinct from PR #18's `src/metrics/aggregate.ts`
 * (a standalone memory monitor). The two do not share state or names.
 */

type EnvelopeType = SlackEventEnvelope["type"];

export interface RecordInput {
  /** Slack envelope type this request originated from. */
  type: EnvelopeType;
  /** Wall-clock request duration in milliseconds. */
  durationMs: number;
  /** Prompt tokens, when known. */
  inputTokens?: number;
  /** Completion tokens, when known. */
  outputTokens?: number;
  /** Request cost in USD, when known. */
  costUsd?: number;
  /** Whether the request ended in an error. */
  isError?: boolean;
}

export interface MetricsSnapshot {
  totalRequests: number;
  totalErrors: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  /** Request count keyed by envelope type. */
  byType: Record<string, number>;
}

interface Counters {
  totalRequests: number;
  totalErrors: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byType: Map<EnvelopeType, number>;
}

function freshCounters(): Counters {
  return {
    totalRequests: 0,
    totalErrors: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    byType: new Map(),
  };
}

let counters: Counters = freshCounters();

/** Record one completed (or failed) request. */
export function record(input: RecordInput): void {
  counters.totalRequests += 1;
  counters.totalDurationMs += input.durationMs;
  counters.totalInputTokens += input.inputTokens ?? 0;
  counters.totalOutputTokens += input.outputTokens ?? 0;
  counters.totalCostUsd += input.costUsd ?? 0;
  if (input.isError) counters.totalErrors += 1;

  counters.byType.set(input.type, (counters.byType.get(input.type) ?? 0) + 1);
}

/** Read a plain-object copy of the current counters. */
export function snapshot(): MetricsSnapshot {
  const byType: Record<string, number> = {};
  for (const [type, count] of counters.byType) byType[type] = count;

  return {
    totalRequests: counters.totalRequests,
    totalErrors: counters.totalErrors,
    totalDurationMs: counters.totalDurationMs,
    totalInputTokens: counters.totalInputTokens,
    totalOutputTokens: counters.totalOutputTokens,
    totalCostUsd: counters.totalCostUsd,
    byType,
  };
}

// Prometheus numbers must be plain (no exponential / locale grouping). For our
// counters this `String()` is fine; cost can be fractional but stays decimal.
function fmt(n: number): string {
  return String(n);
}

/** Render the current counters in Prometheus text exposition format (v0.0.4). */
export function renderPrometheus(): string {
  const s = snapshot();
  const lines: string[] = [];

  const metric = (
    name: string,
    type: "counter" | "gauge",
    help: string,
    samples: Array<{ labels?: string; value: number }>
  ): void => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    for (const sample of samples) {
      const labels = sample.labels ? `{${sample.labels}}` : "";
      lines.push(`${name}${labels} ${fmt(sample.value)}`);
    }
  };

  // Total requests, plus a labelled series per envelope type.
  const byTypeSamples = Object.entries(s.byType).map(([type, value]) => ({
    labels: `type="${type}"`,
    value,
  }));
  metric("sentinel_requests_total", "counter", "Total Claude requests handled", [
    { value: s.totalRequests },
    ...byTypeSamples,
  ]);

  metric("sentinel_errors_total", "counter", "Total requests that ended in error", [
    { value: s.totalErrors },
  ]);

  metric(
    "sentinel_request_duration_ms_sum",
    "counter",
    "Summed wall-clock request duration in milliseconds",
    [{ value: s.totalDurationMs }]
  );

  metric("sentinel_input_tokens_total", "counter", "Total prompt (input) tokens", [
    { value: s.totalInputTokens },
  ]);

  metric(
    "sentinel_output_tokens_total",
    "counter",
    "Total completion (output) tokens",
    [{ value: s.totalOutputTokens }]
  );

  metric("sentinel_cost_usd_total", "counter", "Total request cost in USD", [
    { value: s.totalCostUsd },
  ]);

  // Trailing newline per Prometheus convention.
  return lines.join("\n") + "\n";
}

/** Test helper: clear all accumulated state. */
export function reset(): void {
  counters = freshCounters();
}
