import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
vi.mock("../src/config.js", () => ({
  config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
}));

// Mock the live analytics case runner so the suite scores without spawning a CLI.
const runAnalyticsCaseMock = vi.fn();
vi.mock("../evals/analyticsEval.js", () => ({
  runAnalyticsCase: (...args: unknown[]) => runAnalyticsCaseMock(...args),
}));

import * as runner from "../evals/runner.js";

describe("runner — analytics suite wiring", () => {
  beforeEach(() => runAnalyticsCaseMock.mockReset());

  it("parseArgs accepts --suite analytics", () => {
    expect(runner.parseArgs(["--suite", "analytics"]).suite).toBe("analytics");
  });

  it("'analytics' is NOT folded into the default 'all' suite selection", () => {
    // The default `npm run eval` must stay offline/CI-safe. parseArgs defaults to
    // 'all'; the runner only treats an explicit '--suite analytics' as the live
    // suite (verified by the main()-level gate; here we assert the type/flag).
    expect(runner.parseArgs([]).suite).toBe("all");
    expect(runner.parseArgs([]).suite).not.toBe("analytics");
  });

  it("scores an analytics suite from case results", async () => {
    runAnalyticsCaseMock
      .mockResolvedValueOnce({ id: "a", score: 0.9, pass: true, routeOk: true })
      .mockResolvedValueOnce({ id: "b", score: 0.4, pass: false, routeOk: true });

    const report = await runner.runEvals({
      runId: "r",
      ranAt: "t",
      analytics: [{ id: "a" }, { id: "b" }] as never,
      deps: { apiKey: "k" },
      threshold: 0.7,
      persist: false,
    });

    const s = report.suites.find((x) => x.suite === "analytics")!;
    expect(s).toBeDefined();
    expect(s.nCases).toBe(2);
    expect(s.nPass).toBe(1);
    expect(s.meanScore).toBeCloseTo(0.65, 5);
  });

  it("threads the analytics model pin into runAnalyticsCase", async () => {
    runAnalyticsCaseMock.mockResolvedValue({ id: "a", score: 1, pass: true, routeOk: true });
    await runner.runEvals({
      runId: "r",
      ranAt: "t",
      analytics: [{ id: "a" }] as never,
      deps: { apiKey: "k" },
      analyticsModel: "gpt-5.4",
      threshold: 0.7,
      persist: false,
    });
    expect(runAnalyticsCaseMock.mock.calls[0][1]).toMatchObject({ model: "gpt-5.4" });
  });

  it("produces no analytics suite when no analytics cases are supplied (back-compat)", async () => {
    const report = await runner.runEvals({
      runId: "r",
      ranAt: "t",
      deps: { apiKey: "k" },
      threshold: 0.8,
      persist: false,
    });
    expect(report.suites.find((x) => x.suite === "analytics")).toBeUndefined();
  });
});
