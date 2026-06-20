import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (memoryStore.test.ts pattern) — modules under test transitively
// import the logger, which imports config; both are mocked per test.
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/**
 * Memory observability counters (PR 5/5 of Memory v1).
 *
 * All imports here are dynamic (after vi.resetModules) so the registry
 * instance is the SAME module instance the code under test increments.
 *
 * Where the increments live (tested at exactly those layers):
 *  - sentinel_memory_facts_total{source}        → memoryStore.insertFact
 *  - sentinel_memory_injected_total             → memoryStore.searchMemories
 *  - sentinel_memory_retrieval_empty_total      → memoryStore.searchMemories
 *  - sentinel_memory_extract_budget_exhausted_total → openaiClient.extractJson
 *  - sentinel_memory_extract_errors_total       → openaiClient.extractJson
 *                                                 (+ conversationHook catch)
 */

function mockConfig(extra: Record<string, unknown> = {}): void {
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent", ...extra },
  }));
}

/** Response-like fake for the injected fetch (openaiClient.test.ts pattern). */
function apiResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function successBody(payload: unknown): unknown {
  return {
    choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
  };
}

const SCHEMA = {
  type: "object",
  properties: { facts: { type: "array" } },
  required: ["facts"],
  additionalProperties: false,
};

describe("memory metrics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
  });

  describe("registry counters + Prometheus rendering", () => {
    it("starts with all memory counters at zero (snapshot + render)", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();

      const s = reg.snapshot();
      expect(s.memory.factsTotal).toBe(0);
      expect(s.memory.factsBySource).toEqual({});
      expect(s.memory.extractErrors).toBe(0);
      expect(s.memory.extractBudgetExhausted).toBe(0);
      expect(s.memory.injected).toBe(0);
      expect(s.memory.retrievalEmpty).toBe(0);

      const text = reg.renderPrometheus();
      expect(text).toMatch(/^sentinel_memory_facts_total 0$/m);
      expect(text).toMatch(/^sentinel_memory_extract_errors_total 0$/m);
      expect(text).toMatch(/^sentinel_memory_extract_budget_exhausted_total 0$/m);
      expect(text).toMatch(/^sentinel_memory_injected_total 0$/m);
      expect(text).toMatch(/^sentinel_memory_retrieval_empty_total 0$/m);
    });

    it("renders HELP/TYPE metadata for every memory counter", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();

      const text = reg.renderPrometheus();
      for (const name of [
        "sentinel_memory_facts_total",
        "sentinel_memory_extract_errors_total",
        "sentinel_memory_extract_budget_exhausted_total",
        "sentinel_memory_injected_total",
        "sentinel_memory_retrieval_empty_total",
      ]) {
        expect(text).toMatch(new RegExp(`# HELP ${name} `));
        expect(text).toMatch(new RegExp(`# TYPE ${name} counter`));
      }
    });

    it("accumulates facts by source and renders per-source labelled series", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();

      reg.recordMemoryFactStored("conversation");
      reg.recordMemoryFactStored("conversation");
      reg.recordMemoryFactStored("meeting");
      reg.recordMemoryFactStored("email");
      reg.recordMemoryFactStored("manual");

      const s = reg.snapshot();
      expect(s.memory.factsTotal).toBe(5);
      expect(s.memory.factsBySource).toEqual({
        conversation: 2,
        meeting: 1,
        email: 1,
        manual: 1,
      });

      const text = reg.renderPrometheus();
      expect(text).toMatch(/^sentinel_memory_facts_total 5$/m);
      expect(text).toMatch(/^sentinel_memory_facts_total\{source="conversation"\} 2$/m);
      expect(text).toMatch(/^sentinel_memory_facts_total\{source="meeting"\} 1$/m);
      expect(text).toMatch(/^sentinel_memory_facts_total\{source="email"\} 1$/m);
      expect(text).toMatch(/^sentinel_memory_facts_total\{source="manual"\} 1$/m);
    });

    it("increments the scalar memory counters and renders them", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();

      reg.recordMemoryExtractError();
      reg.recordMemoryExtractError();
      reg.recordMemoryExtractBudgetExhausted();
      reg.recordMemoryInjected(4);
      reg.recordMemoryInjected(2);
      reg.recordMemoryRetrievalEmpty();

      const s = reg.snapshot();
      expect(s.memory.extractErrors).toBe(2);
      expect(s.memory.extractBudgetExhausted).toBe(1);
      expect(s.memory.injected).toBe(6);
      expect(s.memory.retrievalEmpty).toBe(1);

      const text = reg.renderPrometheus();
      expect(text).toMatch(/^sentinel_memory_extract_errors_total 2$/m);
      expect(text).toMatch(/^sentinel_memory_extract_budget_exhausted_total 1$/m);
      expect(text).toMatch(/^sentinel_memory_injected_total 6$/m);
      expect(text).toMatch(/^sentinel_memory_retrieval_empty_total 1$/m);
    });

    it("memory sample lines keep the `name{labels} value` Prometheus shape", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      reg.recordMemoryFactStored("meeting");

      const sampleLines = reg
        .renderPrometheus()
        .split("\n")
        .filter((l) => l.startsWith("sentinel_memory_"));
      expect(sampleLines.length).toBeGreaterThan(0);
      for (const line of sampleLines) {
        expect(line).toMatch(/^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/);
      }
    });

    it("reset() clears the memory counters too", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.recordMemoryFactStored("email");
      reg.recordMemoryExtractError();
      reg.recordMemoryExtractBudgetExhausted();
      reg.recordMemoryInjected(3);
      reg.recordMemoryRetrievalEmpty();

      reg.reset();

      const s = reg.snapshot();
      expect(s.memory.factsTotal).toBe(0);
      expect(s.memory.factsBySource).toEqual({});
      expect(s.memory.extractErrors).toBe(0);
      expect(s.memory.extractBudgetExhausted).toBe(0);
      expect(s.memory.injected).toBe(0);
      expect(s.memory.retrievalEmpty).toBe(0);
    });
  });

  describe("memoryStore wrappers increment facts/injected/empty", () => {
    it("insertFact counts one stored event per call, labelled by source — dedup included", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const store = await import("../src/memory/memoryStore.js");

      const first = store.insertFact({
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "meeting",
      });
      expect(first.deduped).toBe(false);

      // Exact re-assertion dedups at the SQL layer but still counts as one
      // stored event (inserted + deduped are both "stored").
      const second = store.insertFact({
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "conversation",
      });
      expect(second.deduped).toBe(true);

      const s = reg.snapshot();
      expect(s.memory.factsTotal).toBe(2);
      expect(s.memory.factsBySource).toEqual({ meeting: 1, conversation: 1 });
    });

    it("a failed insert does not count", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const store = await import("../src/memory/memoryStore.js");

      expect(() =>
        store.insertFact({ text: "   ", category: "fact", sourceType: "manual" })
      ).toThrow();

      expect(reg.snapshot().memory.factsTotal).toBe(0);
    });

    it("searchMemories with hits increments injected by the hit count (not retrieval_empty)", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const store = await import("../src/memory/memoryStore.js");

      store.insertFact({
        text: "Average CTC for the 2026 placements batch is 12 LPA",
        category: "metric",
        sourceType: "meeting",
      });
      store.insertFact({
        text: "Placements team closed 45 offers in May",
        category: "metric",
        sourceType: "meeting",
      });

      const hits = store.searchMemories("how are placements doing?");
      expect(hits.length).toBeGreaterThan(0);

      const s = reg.snapshot();
      expect(s.memory.injected).toBe(hits.length);
      expect(s.memory.retrievalEmpty).toBe(0);
    });

    it("searchMemories with zero hits increments retrieval_empty (not injected)", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const store = await import("../src/memory/memoryStore.js");

      store.insertFact({
        text: "Average CTC for the 2026 placements batch is 12 LPA",
        category: "metric",
        sourceType: "meeting",
      });

      const hits = store.searchMemories("xylophone quarterly zeppelin");
      expect(hits).toHaveLength(0);

      const s = reg.snapshot();
      expect(s.memory.retrievalEmpty).toBe(1);
      expect(s.memory.injected).toBe(0);
    });

    it("a query that sanitizes to nothing also counts as retrieval_empty", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const store = await import("../src/memory/memoryStore.js");

      const hits = store.searchMemories("   ");
      expect(hits).toHaveLength(0);
      expect(reg.snapshot().memory.retrievalEmpty).toBe(1);
    });
  });

  describe("openaiClient increments budget-exhausted and extract errors", () => {
    it("counts one extract error on a non-ok HTTP response", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const { extractJson, __resetBudgetForTests } = await import(
        "../src/llm/openaiClient.js"
      );
      __resetBudgetForTests();

      const fetchImpl = vi.fn(async () => apiResponse({ error: "nope" }, 403));
      const result = await extractJson({
        system: "s",
        user: "u",
        schema: SCHEMA,
        apiKey: "sk-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toBeNull();
      const s = reg.snapshot();
      expect(s.memory.extractErrors).toBe(1);
      expect(s.memory.extractBudgetExhausted).toBe(0);
    });

    it("counts one extract error on a network failure", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const { extractJson, __resetBudgetForTests } = await import(
        "../src/llm/openaiClient.js"
      );
      __resetBudgetForTests();

      const fetchImpl = vi.fn(async () => {
        throw new Error("ECONNRESET");
      });
      await extractJson({
        system: "s",
        user: "u",
        schema: SCHEMA,
        apiKey: "sk-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(reg.snapshot().memory.extractErrors).toBe(1);
    });

    it("a successful extraction increments neither counter", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const { extractJson, __resetBudgetForTests } = await import(
        "../src/llm/openaiClient.js"
      );
      __resetBudgetForTests();

      const fetchImpl = vi.fn(async () => apiResponse(successBody({ facts: [] })));
      const result = await extractJson({
        system: "s",
        user: "u",
        schema: SCHEMA,
        apiKey: "sk-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(result).toEqual({ facts: [] });
      const s = reg.snapshot();
      expect(s.memory.extractErrors).toBe(0);
      expect(s.memory.extractBudgetExhausted).toBe(0);
    });

    it("counts budget exhaustion (not an extract error) on the over-budget call", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const { extractJson, __resetBudgetForTests, MAX_EXTRACTION_CALLS_PER_DAY } =
        await import("../src/llm/openaiClient.js");
      __resetBudgetForTests();

      const nowMs = Date.UTC(2026, 5, 11, 10, 0, 0);
      const fetchImpl = vi.fn(async () => apiResponse(successBody({ facts: [] })));
      const call = () =>
        extractJson({
          system: "s",
          user: "u",
          schema: SCHEMA,
          apiKey: "sk-test",
          fetchImpl: fetchImpl as unknown as typeof fetch,
          now: () => nowMs,
        });

      for (let i = 0; i < MAX_EXTRACTION_CALLS_PER_DAY; i++) {
        await call();
      }
      expect(reg.snapshot().memory.extractBudgetExhausted).toBe(0);

      // Over-budget call: blocked → budget counter only.
      expect(await call()).toBeNull();
      const s = reg.snapshot();
      expect(s.memory.extractBudgetExhausted).toBe(1);
      expect(s.memory.extractErrors).toBe(0);
    });

    it("a missing API key increments nothing (config state, not an error)", async () => {
      mockConfig();
      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const { extractJson, __resetBudgetForTests } = await import(
        "../src/llm/openaiClient.js"
      );
      __resetBudgetForTests();

      await extractJson({ system: "s", user: "u", schema: SCHEMA });

      const s = reg.snapshot();
      expect(s.memory.extractErrors).toBe(0);
      expect(s.memory.extractBudgetExhausted).toBe(0);
    });
  });

  describe("conversationHook counts pipeline failures as extract errors", () => {
    it("an exploding extractor increments extract_errors via the detached catch", async () => {
      mockConfig({ OPENAI_API_KEY: "sk-openai-test" });
      vi.doMock("../src/memory/extractor.js", () => ({
        extractFacts: vi.fn(async () => {
          throw new Error("extractor boom");
        }),
      }));

      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const hook = await import("../src/memory/conversationHook.js");

      hook.extractFromConversation({
        queryText:
          "We decided to move the launch to July 15 and Priya owns the pricing page revamp.",
        responseText: "reply",
        channelId: "C123",
        threadTs: "1718000000.000100",
        injectedMemories: [],
      });
      await hook.__testing.flush();

      expect(reg.snapshot().memory.extractErrors).toBe(1);
    });

    it("a clean no-facts run increments nothing", async () => {
      mockConfig({ OPENAI_API_KEY: "sk-openai-test" });
      vi.doMock("../src/memory/extractor.js", () => ({
        extractFacts: vi.fn(async () => []),
      }));

      const reg = await import("../src/metrics/registry.js");
      reg.reset();
      const hook = await import("../src/memory/conversationHook.js");

      hook.extractFromConversation({
        queryText:
          "We decided to move the launch to July 15 and Priya owns the pricing page revamp.",
        responseText: "reply",
        channelId: "C123",
        threadTs: "1718000000.000100",
        injectedMemories: [],
      });
      await hook.__testing.flush();

      const s = reg.snapshot();
      expect(s.memory.extractErrors).toBe(0);
      expect(s.memory.factsTotal).toBe(0);
    });
  });
});
