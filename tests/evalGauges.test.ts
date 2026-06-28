import { describe, it, expect, vi, beforeEach } from "vitest";

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
  const gauges = await import("../src/metrics/evalGauges.js");
  return { db, store, gauges };
}

describe("renderEvalGauges", () => {
  beforeEach(() => vi.resetModules());

  it("emits pass-ratio + mean-score gauges from the latest eval run per suite", async () => {
    const { db, store, gauges } = await load();
    db.getDb();
    store.recordEvalRun({ runId: "old", suite: "extraction", nCases: 4, nPass: 1, meanScore: 0.25, ranAt: "2026-06-20T00:00:00.000Z" });
    store.recordEvalRun({ runId: "new", suite: "extraction", nCases: 4, nPass: 3, meanScore: 0.81, ranAt: "2026-06-27T00:00:00.000Z" });

    const text = gauges.renderEvalGauges();
    expect(text).toMatch(/# TYPE sentinel_eval_pass_ratio gauge/);
    expect(text).toContain('sentinel_eval_pass_ratio{suite="extraction"} 0.75'); // latest run: 3/4
    expect(text).toContain('sentinel_eval_mean_score{suite="extraction"} 0.81');
  });

  it("returns no extraction series when there are no runs (no crash)", async () => {
    const { db, gauges } = await load();
    db.getDb();
    const text = gauges.renderEvalGauges();
    expect(text).not.toContain('suite="extraction"');
  });

  it("never throws even if the DB is unavailable", async () => {
    vi.resetModules();
    vi.doMock("pino", () => {
      const noop = () => {};
      const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
      const pino = () => logger;
      pino.stdTimeFunctions = { isoTime: () => "" };
      return { default: pino };
    });
    vi.doMock("../src/state/evalRuns.js", () => ({
      latestEvalRunBySuite: () => {
        throw new Error("db down");
      },
    }));
    const gauges = await import("../src/metrics/evalGauges.js");
    expect(() => gauges.renderEvalGauges()).not.toThrow();
    expect(gauges.renderEvalGauges()).toBe("");
  });
});
