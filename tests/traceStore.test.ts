import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

function pinoMock() {
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
}

/** Load traceStore + collaborators wired to a fresh in-memory DB. */
async function load() {
  vi.resetModules();
  pinoMock();
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  const db = await import("../src/state/db.js");
  const traceStore = await import("../src/llm/traceStore.js");
  const traceContext = await import("../src/llm/traceContext.js");
  const registry = await import("../src/metrics/registry.js");
  return { db, traceStore, traceContext, registry };
}

describe("traceStore.recordLlmCall", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("writes a row carrying the trace_id + user_id from the active trace", async () => {
    const { db, traceStore, traceContext, registry } = await load();
    db.getDb(); // open so isDbOpen() is true
    registry.reset();

    traceContext.runWithTrace({ traceId: "T1", userId: "U1" }, () => {
      traceStore.recordLlmCall({
        provider: "openai",
        model: "gpt-4o-mini",
        operation: "extract",
        inputTokens: 100,
        outputTokens: 50,
        costUsd: 0.0001,
        latencyMs: 120,
        status: "ok",
      });
    });

    const row = db.getDb().prepare("SELECT * FROM llm_calls").get() as Record<string, unknown>;
    expect(row.trace_id).toBe("T1");
    expect(row.user_id).toBe("U1");
    expect(row.provider).toBe("openai");
    expect(row.model).toBe("gpt-4o-mini");
    expect(row.operation).toBe("extract");
    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cost_usd).toBeCloseTo(0.0001, 12);
    expect(row.latency_ms).toBe(120);
    expect(row.status).toBe("ok");
    expect(row.call_id).toBeTruthy();
    expect(typeof row.created_at).toBe("string");

    // forwards to the metrics registry too
    expect(registry.snapshot().llm.calls["openai|gpt-4o-mini|extract|ok"]).toBe(1);

    db.closeDb();
  });

  it("uses an 'untraced' trace id outside any trace scope and defaults status to ok", async () => {
    const { db, traceStore } = await load();
    db.getDb();
    traceStore.recordLlmCall({ provider: "anthropic", model: "claude", operation: "reply", numTurns: 3 });
    const row = db.getDb().prepare("SELECT trace_id, status, num_turns FROM llm_calls").get() as Record<string, unknown>;
    expect(row.trace_id).toBe("untraced");
    expect(row.status).toBe("ok");
    expect(row.num_turns).toBe(3);
    db.closeDb();
  });

  it("persists the prompt_version stamp", async () => {
    const { db, traceStore } = await load();
    db.getDb();
    traceStore.recordLlmCall({
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "extract",
      status: "ok",
      promptVersion: "extraction@1.0.0+7d9323b8ba5a",
    });
    const row = db.getDb().prepare("SELECT prompt_version FROM llm_calls").get() as Record<string, unknown>;
    expect(row.prompt_version).toBe("extraction@1.0.0+7d9323b8ba5a");
    db.closeDb();
  });

  it("persists error status + error_kind", async () => {
    const { db, traceStore } = await load();
    db.getDb();
    traceStore.recordLlmCall({ provider: "anthropic", model: "claude", operation: "reply", status: "error", errorKind: "timeout", latencyMs: 1000 });
    const row = db.getDb().prepare("SELECT status, error_kind FROM llm_calls").get() as Record<string, unknown>;
    expect(row.status).toBe("error");
    expect(row.error_kind).toBe("timeout");
    db.closeDb();
  });

  it("never auto-opens the DB: records metrics only when the DB is not live", async () => {
    const { db, traceStore, registry } = await load();
    registry.reset();
    expect(db.isDbOpen()).toBe(false);

    expect(() =>
      traceStore.recordLlmCall({ provider: "openai", model: "m", operation: "embed", status: "ok", latencyMs: 10 })
    ).not.toThrow();

    // The durable sink must not have opened a stray DB (no test pollution)...
    expect(db.isDbOpen()).toBe(false);
    // ...but the in-memory metric is still recorded.
    expect(registry.snapshot().llm.calls["openai|m|embed|ok"]).toBe(1);
  });

  it("swallows a durable-write failure (never throws) while still recording metrics", async () => {
    vi.resetModules();
    pinoMock();
    vi.doMock("../src/state/db.js", () => ({
      isDbOpen: () => true,
      getDb: () => {
        throw new Error("db down");
      },
    }));
    const traceStore = await import("../src/llm/traceStore.js");
    const registry = await import("../src/metrics/registry.js");
    registry.reset();

    expect(() =>
      traceStore.recordLlmCall({ provider: "openai", model: "m", operation: "embed", status: "ok", latencyMs: 5 })
    ).not.toThrow();
    expect(registry.snapshot().llm.calls["openai|m|embed|ok"]).toBe(1);
  });
});
