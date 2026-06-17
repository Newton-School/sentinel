import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/** Insert an llm_calls row with an explicit created_at ISO timestamp. */
function insertRow(db: Database.Database, traceId: string, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
     VALUES (?, ?, 'openai', 'gpt-4o-mini', 'extract', 'ok', ?)`
  ).run(`${traceId}:${createdAtMs}`, traceId, new Date(createdAtMs).toISOString());
}

describe("pruneLlmCalls", () => {
  let getDb: typeof import("../src/state/db.js").getDb;
  let pruneLlmCalls: typeof import("../src/state/db.js").pruneLlmCalls;
  let closeDb: typeof import("../src/state/db.js").closeDb;
  let db: Database.Database;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-06-02T00:00:00.000Z");

  beforeEach(async () => {
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

    const mod = await import("../src/state/db.js");
    getDb = mod.getDb;
    pruneLlmCalls = mod.pruneLlmCalls;
    closeDb = mod.closeDb;
    db = getDb();
    db.exec("DELETE FROM llm_calls");
  });

  afterEach(() => {
    closeDb();
  });

  it("deletes rows older than the retention window and keeps recent rows", () => {
    insertRow(db, "T1", NOW - 100 * DAY_MS);
    insertRow(db, "T2", NOW - 91 * DAY_MS);
    insertRow(db, "T3", NOW - 89 * DAY_MS);
    insertRow(db, "T4", NOW);

    const deleted = pruneLlmCalls(90, NOW);

    expect(deleted).toBe(2);
    const remaining = db
      .prepare("SELECT trace_id FROM llm_calls ORDER BY trace_id")
      .all() as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T3", "T4"]);
  });

  it("keeps a row exactly at the retention boundary", () => {
    insertRow(db, "T1", NOW - 90 * DAY_MS);
    expect(pruneLlmCalls(90, NOW)).toBe(0);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM llm_calls").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("respects a custom retention window", () => {
    insertRow(db, "T1", NOW - 40 * DAY_MS);
    insertRow(db, "T2", NOW - 20 * DAY_MS);
    expect(pruneLlmCalls(30, NOW)).toBe(1);
    const remaining = db.prepare("SELECT trace_id FROM llm_calls").all() as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T2"]);
  });

  it("defaults retention to 90 days and uses the current time when nowMs is omitted", () => {
    insertRow(db, "T_old", Date.now() - 200 * DAY_MS);
    insertRow(db, "T_new", Date.now());
    expect(pruneLlmCalls()).toBe(1);
    const remaining = db.prepare("SELECT trace_id FROM llm_calls").all() as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T_new"]);
  });
});
