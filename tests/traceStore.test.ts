import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

/** Load traceStore + collaborators wired to this worker's Postgres test DB. */
async function load() {
  vi.resetModules();
  pinoMock();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const db = await import("../src/state/db.js");
  await db.initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const traceStore = await import("../src/llm/traceStore.js");
  const traceContext = await import("../src/llm/traceContext.js");
  const registry = await import("../src/metrics/registry.js");
  return { db, traceStore, traceContext, registry };
}

/**
 * recordLlmCall is a synchronous, never-throwing fire-and-forget sink: the
 * durable INSERT runs as an internally-caught floating promise. Poll until the
 * expected number of llm_calls rows has landed (or fail after a short timeout).
 */
async function waitForLlmCalls(
  db: typeof import("../src/state/db.js"),
  expected: number,
  timeoutMs = 2000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = ((await db.getPool().query("SELECT COUNT(*)::int AS c FROM llm_calls")).rows[0] as { c: number }).c;
    if (c >= expected || Date.now() > deadline) return c;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("traceStore.recordLlmCall", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    // Some tests mock src/state/db.js (no closeDb export) or never open a pool;
    // re-import defensively and only close a real, open pool.
    const db = await import("../src/state/db.js");
    if (typeof db.closeDb === "function" && typeof db.isDbOpen === "function" && db.isDbOpen()) {
      await db.closeDb();
    }
  });

  it("writes a row carrying the trace_id + user_id from the active trace", async () => {
    const { db, traceStore, traceContext, registry } = await load();
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

    await waitForLlmCalls(db, 1);
    const row = (await db.getPool().query("SELECT * FROM llm_calls")).rows[0] as Record<string, unknown>;
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
  });

  it("uses an 'untraced' trace id outside any trace scope and defaults status to ok", async () => {
    const { db, traceStore } = await load();
    traceStore.recordLlmCall({ provider: "openai", model: "gpt-5.4-mini", operation: "reply", numTurns: 3 });
    await waitForLlmCalls(db, 1);
    const row = (await db.getPool().query("SELECT trace_id, status, num_turns FROM llm_calls")).rows[0] as Record<string, unknown>;
    expect(row.trace_id).toBe("untraced");
    expect(row.status).toBe("ok");
    expect(row.num_turns).toBe(3);
  });

  it("persists the prompt_version stamp", async () => {
    const { db, traceStore } = await load();
    traceStore.recordLlmCall({
      provider: "openai",
      model: "gpt-4o-mini",
      operation: "extract",
      status: "ok",
      promptVersion: "extraction@1.0.0+7d9323b8ba5a",
    });
    await waitForLlmCalls(db, 1);
    const row = (await db.getPool().query("SELECT prompt_version FROM llm_calls")).rows[0] as Record<string, unknown>;
    expect(row.prompt_version).toBe("extraction@1.0.0+7d9323b8ba5a");
  });

  it("persists error status + error_kind", async () => {
    const { db, traceStore } = await load();
    traceStore.recordLlmCall({ provider: "openai", model: "gpt-5.4-mini", operation: "reply", status: "error", errorKind: "timeout", latencyMs: 1000 });
    await waitForLlmCalls(db, 1);
    const row = (await db.getPool().query("SELECT status, error_kind FROM llm_calls")).rows[0] as Record<string, unknown>;
    expect(row.status).toBe("error");
    expect(row.error_kind).toBe("timeout");
  });

  it("never auto-opens the DB: records metrics only when the DB is not live", async () => {
    // No initDb() here: the sink must stay dormant when the pool isn't open.
    vi.resetModules();
    pinoMock();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const db = await import("../src/state/db.js");
    const traceStore = await import("../src/llm/traceStore.js");
    const registry = await import("../src/metrics/registry.js");
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
      getPool: () => {
        throw new Error("db down");
      },
      // afterEach defensively probes closeDb on the (mocked) module — provide it
      // so accessing the export doesn't trip vitest's missing-export guard.
      closeDb: async () => {},
    }));
    const traceStore = await import("../src/llm/traceStore.js");
    const registry = await import("../src/metrics/registry.js");
    registry.reset();

    expect(() =>
      traceStore.recordLlmCall({ provider: "openai", model: "m", operation: "embed", status: "ok", latencyMs: 5 })
    ).not.toThrow();
    expect(registry.snapshot().llm.calls["openai|m|embed|ok"]).toBe(1);
    // Give the internally-caught floating write a tick to settle (it swallows
    // the thrown getPool()).
    await new Promise((r) => setTimeout(r, 20));
  });
});
