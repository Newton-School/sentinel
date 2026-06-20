import type { SlackEventEnvelope } from "../types/contracts.js";
import type { MemorySourceType } from "../memory/types.js";

/**
 * In-process ops metrics for Sentinel requests + the organizational memory
 * subsystem.
 *
 * Side-effect-free and dependency-free: a module-scoped mutable counter set
 * that the record* functions mutate and `snapshot()` / `renderPrometheus()`
 * read. The Prometheus text exposition format (v0.0.4) is hand-rolled — no
 * client lib.
 *
 * SCOPE NOTE: these counters only see THIS process. The memory MCP server
 * (`src/mcp/memory.ts`) runs as a separate stdio subprocess with its own
 * SQLite handle and does NOT report metrics — manual memory_store/forget/
 * supersede done through chat tools are invisible here by design.
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

/**
 * Latency histogram bucket upper-bounds (ms). A call's latency lands in the
 * first bucket whose bound it does not exceed; latencies above the largest
 * bound appear only in the implicit `+Inf` bucket (== count). Cumulative
 * `le=` lines are produced at render time.
 */
export const LLM_LATENCY_BUCKETS_MS = [
  50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 120000,
];

/** One LLM call's metrics (see src/llm/traceStore.recordLlmCall). */
export interface RecordLlmMetricInput {
  provider: string;
  model: string;
  operation: string;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
}

/** Per-(provider,model,operation) aggregate of tokens/cost + a latency histogram. */
interface LlmAgg {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Non-cumulative per-bucket counts, parallel to LLM_LATENCY_BUCKETS_MS. */
  buckets: number[];
  latencySum: number;
  latencyCount: number;
}

export interface MemoryMetricsSnapshot {
  /** Total stored-fact events (insert or dedup-reinforce), all sources. */
  factsTotal: number;
  /** Stored-fact events keyed by memory source type. */
  factsBySource: Record<string, number>;
  extractErrors: number;
  extractBudgetExhausted: number;
  /** Sum of memories injected into system prompts. */
  injected: number;
  /** Recall queries that returned zero memories. */
  retrievalEmpty: number;
  /** Entity-resolution outcomes keyed by outcome (matched/created/ambiguous). */
  entitiesResolved: Record<string, number>;
  /** Total entity-resolution attempts across all outcomes. */
  entitiesResolvedTotal: number;
  /** Embedding outcomes keyed by result (ok/error). */
  embeddings: Record<string, number>;
  /** Total embedding attempts across all results. */
  embeddingsTotal: number;
}

/** A single entity-resolution outcome (see entityLink.linkFactEntities). */
export type EntityResolutionOutcome = "matched" | "created" | "ambiguous";

/** A single embedding outcome (see embeddingBackfill). */
export type EmbeddingResult = "ok" | "error";

/** Per-call LLM trace metrics (see src/llm/traceStore). */
export interface LlmMetricsSnapshot {
  /** Call counts keyed by "provider|model|operation|status". */
  calls: Record<string, number>;
  /** Input tokens keyed by "provider|model|operation". */
  inputTokens: Record<string, number>;
  /** Output tokens keyed by "provider|model|operation". */
  outputTokens: Record<string, number>;
  /** Cost (USD) keyed by "provider|model|operation". */
  costUsd: Record<string, number>;
  /** Latency histogram keyed by "provider|model|operation". */
  latency: Record<string, { buckets: number[]; sum: number; count: number }>;
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
  /** Organizational-memory subsystem counters. */
  memory: MemoryMetricsSnapshot;
  /** Per-call LLM trace metrics. */
  llm: LlmMetricsSnapshot;
  /** Online user-feedback counts (👍/👎 reactions on bot replies). */
  feedback: { positive: number; negative: number };
}

interface Counters {
  totalRequests: number;
  totalErrors: number;
  totalDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  byType: Map<EnvelopeType, number>;
  memoryFactsBySource: Map<MemorySourceType, number>;
  memoryExtractErrors: number;
  memoryExtractBudgetExhausted: number;
  memoryInjected: number;
  memoryRetrievalEmpty: number;
  memoryEntitiesResolved: Map<EntityResolutionOutcome, number>;
  memoryEmbeddings: Map<EmbeddingResult, number>;
  /** Call counts keyed by "provider|model|operation|status". */
  llmCalls: Map<string, number>;
  /** Token/cost/latency aggregates keyed by "provider|model|operation". */
  llmAgg: Map<string, LlmAgg>;
  feedbackPositive: number;
  feedbackNegative: number;
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
    memoryFactsBySource: new Map(),
    memoryExtractErrors: 0,
    memoryExtractBudgetExhausted: 0,
    memoryInjected: 0,
    memoryRetrievalEmpty: 0,
    memoryEntitiesResolved: new Map(),
    memoryEmbeddings: new Map(),
    llmCalls: new Map(),
    llmAgg: new Map(),
    feedbackPositive: 0,
    feedbackNegative: 0,
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

/**
 * Record one LLM call (agent reply or OpenAI extract/embed/...) into the
 * labeled LLM series. Distinct from {@link record}: that aggregates per Slack
 * request; this is per individual provider call. Call counts carry a status
 * label; token/cost/latency are keyed by provider|model|operation only.
 */
export function recordLlmMetric(input: RecordLlmMetricInput): void {
  const base = `${input.provider}|${input.model}|${input.operation}`;
  const callKey = `${base}|${input.status}`;
  counters.llmCalls.set(callKey, (counters.llmCalls.get(callKey) ?? 0) + 1);

  let agg = counters.llmAgg.get(base);
  if (!agg) {
    agg = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      buckets: new Array(LLM_LATENCY_BUCKETS_MS.length).fill(0),
      latencySum: 0,
      latencyCount: 0,
    };
    counters.llmAgg.set(base, agg);
  }
  agg.inputTokens += input.inputTokens ?? 0;
  agg.outputTokens += input.outputTokens ?? 0;
  agg.costUsd += input.costUsd ?? 0;

  if (typeof input.latencyMs === "number" && input.latencyMs >= 0) {
    agg.latencySum += input.latencyMs;
    agg.latencyCount += 1;
    for (let i = 0; i < LLM_LATENCY_BUCKETS_MS.length; i++) {
      if (input.latencyMs <= LLM_LATENCY_BUCKETS_MS[i]) {
        agg.buckets[i] += 1;
        break;
      }
    }
    // latencies above the largest finite bucket only show up at +Inf (==count)
  }
}

/** Record one user-feedback reaction (👍/👎) on a bot reply. */
export function recordFeedback(sentiment: "positive" | "negative"): void {
  if (sentiment === "positive") counters.feedbackPositive += 1;
  else counters.feedbackNegative += 1;
}

// --- Memory subsystem counters ----------------------------------------------
// Incremented at the in-process edges of the memory pipeline:
//   facts        → memoryStore.insertFact (insert AND dedup count as "stored")
//   injected /
//   retrievalEmpty → memoryStore.searchMemories (the sole in-process recall
//                    path; its return value is exactly what systemPrompt.ts
//                    injects)
//   extractErrors  → openaiClient.extractJson failure paths +
//                    conversationHook's detached catch
//   budgetExhausted → openaiClient's daily-cap gate

/** Record one stored-fact event (new insert or dedup-reinforce). */
export function recordMemoryFactStored(source: MemorySourceType): void {
  counters.memoryFactsBySource.set(
    source,
    (counters.memoryFactsBySource.get(source) ?? 0) + 1
  );
}

/** Record one failed LLM fact-extraction attempt. */
export function recordMemoryExtractError(): void {
  counters.memoryExtractErrors += 1;
}

/** Record one extraction call blocked by the daily LLM-call budget. */
export function recordMemoryExtractBudgetExhausted(): void {
  counters.memoryExtractBudgetExhausted += 1;
}

/** Record `count` memories recalled + injected into a system prompt. */
export function recordMemoryInjected(count: number): void {
  counters.memoryInjected += count;
}

/** Record one recall query that returned zero memories. */
export function recordMemoryRetrievalEmpty(): void {
  counters.memoryRetrievalEmpty += 1;
}

/** Record one entity-resolution attempt and its outcome (company brain). */
export function recordEntityResolution(outcome: EntityResolutionOutcome): void {
  counters.memoryEntitiesResolved.set(
    outcome,
    (counters.memoryEntitiesResolved.get(outcome) ?? 0) + 1
  );
}

/** Record one embedding attempt and its result (company brain). */
export function recordEmbedding(result: EmbeddingResult): void {
  counters.memoryEmbeddings.set(result, (counters.memoryEmbeddings.get(result) ?? 0) + 1);
}

/** Read a plain-object copy of the current counters. */
export function snapshot(): MetricsSnapshot {
  const byType: Record<string, number> = {};
  for (const [type, count] of counters.byType) byType[type] = count;

  const factsBySource: Record<string, number> = {};
  let factsTotal = 0;
  for (const [source, count] of counters.memoryFactsBySource) {
    factsBySource[source] = count;
    factsTotal += count;
  }

  const entitiesResolved: Record<string, number> = {};
  let entitiesResolvedTotal = 0;
  for (const [outcome, count] of counters.memoryEntitiesResolved) {
    entitiesResolved[outcome] = count;
    entitiesResolvedTotal += count;
  }

  const embeddings: Record<string, number> = {};
  let embeddingsTotal = 0;
  for (const [result, count] of counters.memoryEmbeddings) {
    embeddings[result] = count;
    embeddingsTotal += count;
  }

  const llmCalls: Record<string, number> = {};
  for (const [key, count] of counters.llmCalls) llmCalls[key] = count;
  const llmInputTokens: Record<string, number> = {};
  const llmOutputTokens: Record<string, number> = {};
  const llmCostUsd: Record<string, number> = {};
  const llmLatency: Record<string, { buckets: number[]; sum: number; count: number }> = {};
  for (const [key, agg] of counters.llmAgg) {
    llmInputTokens[key] = agg.inputTokens;
    llmOutputTokens[key] = agg.outputTokens;
    llmCostUsd[key] = agg.costUsd;
    llmLatency[key] = { buckets: [...agg.buckets], sum: agg.latencySum, count: agg.latencyCount };
  }

  return {
    totalRequests: counters.totalRequests,
    totalErrors: counters.totalErrors,
    totalDurationMs: counters.totalDurationMs,
    totalInputTokens: counters.totalInputTokens,
    totalOutputTokens: counters.totalOutputTokens,
    totalCostUsd: counters.totalCostUsd,
    byType,
    memory: {
      factsTotal,
      factsBySource,
      extractErrors: counters.memoryExtractErrors,
      extractBudgetExhausted: counters.memoryExtractBudgetExhausted,
      injected: counters.memoryInjected,
      retrievalEmpty: counters.memoryRetrievalEmpty,
      entitiesResolved,
      entitiesResolvedTotal,
      embeddings,
      embeddingsTotal,
    },
    llm: {
      calls: llmCalls,
      inputTokens: llmInputTokens,
      outputTokens: llmOutputTokens,
      costUsd: llmCostUsd,
      latency: llmLatency,
    },
    feedback: {
      positive: counters.feedbackPositive,
      negative: counters.feedbackNegative,
    },
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
  metric("sentinel_requests_total", "counter", "Total agent requests handled", [
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

  // Memory subsystem: total + a labelled series per source (mirrors the
  // sentinel_requests_total{type=...} pattern).
  const bySourceSamples = Object.entries(s.memory.factsBySource).map(
    ([source, value]) => ({ labels: `source="${source}"`, value })
  );
  metric(
    "sentinel_memory_facts_total",
    "counter",
    "Memory facts stored (insert or dedup-reinforce)",
    [{ value: s.memory.factsTotal }, ...bySourceSamples]
  );

  metric(
    "sentinel_memory_extract_errors_total",
    "counter",
    "Failed LLM fact-extraction attempts",
    [{ value: s.memory.extractErrors }]
  );

  metric(
    "sentinel_memory_extract_budget_exhausted_total",
    "counter",
    "Extraction calls blocked by the daily LLM-call budget",
    [{ value: s.memory.extractBudgetExhausted }]
  );

  metric(
    "sentinel_memory_injected_total",
    "counter",
    "Memories injected into system prompts",
    [{ value: s.memory.injected }]
  );

  metric(
    "sentinel_memory_retrieval_empty_total",
    "counter",
    "Recall queries that returned zero memories",
    [{ value: s.memory.retrievalEmpty }]
  );

  // Company brain: entity-resolution outcomes (total + a labelled series per
  // outcome — matched/created/ambiguous).
  const byOutcomeSamples = Object.entries(s.memory.entitiesResolved).map(
    ([outcome, value]) => ({ labels: `outcome="${outcome}"`, value })
  );
  metric(
    "sentinel_memory_entity_resolved_total",
    "counter",
    "Entity-resolution attempts during fact linking",
    [{ value: s.memory.entitiesResolvedTotal }, ...byOutcomeSamples]
  );

  const byEmbedResult = Object.entries(s.memory.embeddings).map(
    ([result, value]) => ({ labels: `result="${result}"`, value })
  );
  metric(
    "sentinel_memory_embeddings_total",
    "counter",
    "Embedding attempts during backfill (ok/error)",
    [{ value: s.memory.embeddingsTotal }, ...byEmbedResult]
  );

  // --- LLM trace metrics (per-call, labeled by provider/model/operation) ----
  // base key "provider|model|operation" → label string (call counts add status)
  const baseLabels = (key: string): string => {
    const [provider, model, operation] = key.split("|");
    return `provider="${provider}",model="${model}",operation="${operation}"`;
  };

  const callSamples = Object.entries(s.llm.calls).map(([key, value]) => {
    const [provider, model, operation, status] = key.split("|");
    return {
      labels: `provider="${provider}",model="${model}",operation="${operation}",status="${status}"`,
      value,
    };
  });
  metric(
    "sentinel_llm_calls_total",
    "counter",
    "LLM calls by provider/model/operation/status",
    callSamples
  );

  metric(
    "sentinel_llm_input_tokens_total",
    "counter",
    "LLM input (prompt) tokens by provider/model/operation",
    Object.entries(s.llm.inputTokens).map(([key, value]) => ({ labels: baseLabels(key), value }))
  );
  metric(
    "sentinel_llm_output_tokens_total",
    "counter",
    "LLM output (completion) tokens by provider/model/operation",
    Object.entries(s.llm.outputTokens).map(([key, value]) => ({ labels: baseLabels(key), value }))
  );
  metric(
    "sentinel_llm_cost_usd_total",
    "counter",
    "LLM cost in USD by provider/model/operation",
    Object.entries(s.llm.costUsd).map(([key, value]) => ({ labels: baseLabels(key), value }))
  );

  // Latency histogram: cumulative le= buckets + +Inf (== count) + _sum/_count.
  lines.push("# HELP sentinel_llm_latency_ms LLM call latency in milliseconds");
  lines.push("# TYPE sentinel_llm_latency_ms histogram");
  for (const [key, h] of Object.entries(s.llm.latency)) {
    const labels = baseLabels(key);
    let cumulative = 0;
    for (let i = 0; i < LLM_LATENCY_BUCKETS_MS.length; i++) {
      cumulative += h.buckets[i];
      lines.push(`sentinel_llm_latency_ms_bucket{${labels},le="${LLM_LATENCY_BUCKETS_MS[i]}"} ${cumulative}`);
    }
    lines.push(`sentinel_llm_latency_ms_bucket{${labels},le="+Inf"} ${h.count}`);
    lines.push(`sentinel_llm_latency_ms_sum{${labels}} ${fmt(h.sum)}`);
    lines.push(`sentinel_llm_latency_ms_count{${labels}} ${h.count}`);
  }

  // Online user feedback (👍/👎 on bot replies) by sentiment.
  metric("sentinel_feedback_total", "counter", "User feedback reactions on bot replies", [
    { labels: `sentiment="positive"`, value: s.feedback.positive },
    { labels: `sentiment="negative"`, value: s.feedback.negative },
  ]);

  // Trailing newline per Prometheus convention.
  return lines.join("\n") + "\n";
}

/** Test helper: clear all accumulated state. */
export function reset(): void {
  counters = freshCounters();
}
