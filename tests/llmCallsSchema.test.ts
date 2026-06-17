import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function loadFreshDb() {
  vi.resetModules();
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  return import("../src/state/db.js");
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all(table) as Array<{ name: string }>
  ).map((i) => i.name);
}

describe("llm_calls schema", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("creates the llm_calls table with the expected columns", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    const cols = colNames(db, "llm_calls");
    for (const c of [
      "id",
      "call_id",
      "trace_id",
      "provider",
      "model",
      "operation",
      "input_tokens",
      "output_tokens",
      "cost_usd",
      "latency_ms",
      "status",
      "error_kind",
      "num_turns",
      "user_id",
      "created_at",
    ]) {
      expect(cols).toContain(c);
    }
    closeDb();
  });

  it("creates the trace / created_at / op+model indexes", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    const idx = indexNames(db, "llm_calls");
    expect(idx).toContain("idx_llm_calls_trace");
    expect(idx).toContain("idx_llm_calls_created_at");
    expect(idx).toContain("idx_llm_calls_op_model");
    closeDb();
  });

  it("accepts a valid row", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
           VALUES ('c1','t1','openai','gpt-4o-mini','extract','ok','2026-06-14T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow();
    closeDb();
  });

  it("rejects an invalid provider via CHECK", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
           VALUES ('c1','t1','google','gemini','reply','ok','2026-06-14T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
    closeDb();
  });

  it("rejects an invalid operation via CHECK", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
           VALUES ('c1','t1','openai','gpt-4o-mini','translate','ok','2026-06-14T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
    closeDb();
  });

  it("rejects an invalid status via CHECK", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
           VALUES ('c1','t1','openai','gpt-4o-mini','extract','pending','2026-06-14T00:00:00.000Z')`
        )
        .run()
    ).toThrow();
    closeDb();
  });

  it("isDbOpen reflects whether the DB handle is live", async () => {
    const { getDb, closeDb, isDbOpen } = await loadFreshDb();
    expect(isDbOpen()).toBe(false);
    getDb();
    expect(isDbOpen()).toBe(true);
    closeDb();
    expect(isDbOpen()).toBe(false);
  });

  it("re-running migrations is idempotent and preserves llm_calls", async () => {
    const first = await loadFreshDb();
    first.getDb();
    first.closeDb();

    const second = await loadFreshDb();
    expect(() => second.getDb()).not.toThrow();
    const cols = colNames(second.getDb(), "llm_calls");
    expect(cols).toContain("trace_id");
    second.closeDb();
  });
});
