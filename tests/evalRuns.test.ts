import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  vi.resetModules();
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../src/config.js", () => ({ config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" } }));
  const db = await import("../src/state/db.js");
  const store = await import("../evals/store.js");
  return { db, store };
}

describe("eval_runs table + store", () => {
  beforeEach(() => vi.resetModules());

  it("creates the eval_runs table with the expected columns", async () => {
    const { db } = await load();
    const cols = (db.getDb().pragma("table_info(eval_runs)") as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["id", "run_id", "suite", "n_cases", "n_pass", "mean_score", "prompt_version", "judge_version", "ran_at"]) {
      expect(cols).toContain(c);
    }
    db.closeDb();
  });

  it("recordEvalRun inserts a row and latestEvalRunBySuite returns the most recent", async () => {
    const { db, store } = await load();
    db.getDb();
    store.recordEvalRun({ runId: "r1", suite: "extraction", nCases: 3, nPass: 2, meanScore: 0.66, ranAt: "2026-06-20T00:00:00.000Z" });
    store.recordEvalRun({ runId: "r2", suite: "extraction", nCases: 3, nPass: 3, meanScore: 0.91, ranAt: "2026-06-27T00:00:00.000Z" });
    store.recordEvalRun({ runId: "r3", suite: "answers", nCases: 2, nPass: 1, meanScore: 0.5, ranAt: "2026-06-27T00:00:00.000Z" });

    const latest = store.latestEvalRunBySuite("extraction");
    expect(latest?.runId).toBe("r2");
    expect(latest?.meanScore).toBeCloseTo(0.91, 5);
    expect(store.latestEvalRunBySuite("answers")?.nPass).toBe(1);
    expect(store.latestEvalRunBySuite("nope")).toBeNull();
    db.closeDb();
  });

  it("pruneEvalRuns deletes runs older than the retention window", async () => {
    const { db, store } = await load();
    db.getDb();
    const DAY = 86_400_000;
    const NOW = Date.parse("2026-06-28T00:00:00.000Z");
    store.recordEvalRun({ runId: "old", suite: "extraction", nCases: 1, nPass: 1, meanScore: 1, ranAt: new Date(NOW - 200 * DAY).toISOString() });
    store.recordEvalRun({ runId: "new", suite: "extraction", nCases: 1, nPass: 1, meanScore: 1, ranAt: new Date(NOW - 10 * DAY).toISOString() });
    expect(db.pruneEvalRuns(180, NOW)).toBe(1);
    expect(store.latestEvalRunBySuite("extraction")?.runId).toBe("new");
    db.closeDb();
  });
});
