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

// --- Memory subsystem counters ----------------------------------------------
// Incremented at the in-process edges of the memory pipeline:
//   facts        → memoryStore.insertFact (insert AND dedup count as "stored")
//   injected /
//   retrievalEmpty → memoryStore.searchMemories (the sole in-process recall
//                    path; its return value is exactly what systemPrompt.ts
//                    injects)
//   extractErrors  → anthropicClient.extractJson failure paths +
//                    conversationHook's detached catch
//   budgetExhausted → anthropicClient's daily-cap gate

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

  // Trailing newline per Prometheus convention.
  return lines.join("\n") + "\n";
}

/** Test helper: clear all accumulated state. */
export function reset(): void {
  counters = freshCounters();
}
