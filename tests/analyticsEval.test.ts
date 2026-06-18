import { describe, it, expect, vi } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
// Replace the real config so importing the runner's transitive deps (runner,
// openaiClient, groundTruth) never triggers loadConfig()/process.exit.
vi.mock("../src/config.js", () => ({ config: {} }));

import { runAnalyticsCase, routeToExpected, type AnalyticsCase, type AnalyticsDeps } from "../evals/analyticsEval.js";

const analyticsCase = (over: Partial<AnalyticsCase> = {}): AnalyticsCase => ({
  id: "c1",
  question: "How many enrollments?",
  expectedRoute: "analytics",
  graded: "ground_truth",
  rubric: ["states a figure matching the ground truth"],
  groundTruthSql: "SELECT COUNT(*) FROM course_user_mapping",
  ...over,
});

const baseDeps = (over: Partial<AnalyticsDeps> = {}): AnalyticsDeps => ({
  judge: { apiKey: "k" },
  decide: vi.fn(async () => ({ kind: "analytics" as const })),
  run: vi.fn(async () => ({ text: "12,431 enrollments (Metabase / Altius)", durationMs: 1200, costUsd: 0.03 })),
  judgeFn: vi.fn(async () => ({ score: 0.9, pass: true, rationale: "matches ground truth" })),
  groundTruthFn: vi.fn(async () => "12431"),
  ...over,
});

describe("routeToExpected", () => {
  it("maps route decisions to dataset route strings", () => {
    expect(routeToExpected({ kind: "analytics" })).toBe("analytics");
    expect(routeToExpected({ kind: "general" })).toBe("general");
  });
});

describe("runAnalyticsCase", () => {
  it("runs the analytics agent, computes ground truth, and judges (happy path)", async () => {
    const deps = baseDeps();
    const r = await runAnalyticsCase(analyticsCase(), deps);
    expect(r.routeOk).toBe(true);
    expect(r.route).toBe("analytics");
    expect(r.groundTruth).toBe("12431");
    expect(r.answer).toContain("12,431");
    expect(r.score).toBe(0.9);
    expect(r.pass).toBe(true);
    expect(r.costUsd).toBe(0.03);
    // judge saw the ground truth
    expect((deps.judgeFn as ReturnType<typeof vi.fn>).mock.calls[0][0].groundTruth).toBe("12431");
  });

  it("fails the case when routing is wrong, even if the judge passes", async () => {
    const deps = baseDeps({ decide: vi.fn(async () => ({ kind: "general" as const })) });
    const r = await runAnalyticsCase(analyticsCase(), deps);
    expect(r.routeOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it("routing_only cases score on the route alone and never run the agent or judge", async () => {
    const run = vi.fn();
    const judgeFn = vi.fn();
    const deps = baseDeps({ decide: vi.fn(async () => ({ kind: "general" as const })), run, judgeFn });
    const r = await runAnalyticsCase(
      analyticsCase({ expectedRoute: "general", graded: "routing_only", groundTruthSql: undefined }),
      deps
    );
    expect(r.routeOk).toBe(true);
    expect(r.pass).toBe(true);
    expect(r.score).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(judgeFn).not.toHaveBeenCalled();
  });

  it("runs a rubric-graded projection request via the analytics route", async () => {
    const deps = baseDeps();
    const r = await runAnalyticsCase(
      analyticsCase({ expectedRoute: "analytics", graded: "rubric", groundTruthSql: undefined }),
      deps
    );
    expect(r.route).toBe("analytics");
    expect(r.routeOk).toBe(true);
    expect(deps.run).toHaveBeenCalled();
  });

  it("skips ground truth when no SQL is supplied (rubric-graded)", async () => {
    const groundTruthFn = vi.fn();
    const deps = baseDeps({ groundTruthFn });
    await runAnalyticsCase(analyticsCase({ graded: "rubric", groundTruthSql: undefined }), deps);
    expect(groundTruthFn).not.toHaveBeenCalled();
  });

  it("returns a failed result (never throws) when the agent run errors", async () => {
    const deps = baseDeps({ run: vi.fn(async () => { throw new Error("cli boom"); }) });
    const r = await runAnalyticsCase(analyticsCase(), deps);
    expect(r.pass).toBe(false);
    expect(r.score).toBe(0);
    expect(r.rationale).toContain("failed");
  });

  it("reports null score when the judge is skipped (no key)", async () => {
    const deps = baseDeps({ judgeFn: vi.fn(async () => null) });
    const r = await runAnalyticsCase(analyticsCase(), deps);
    expect(r.score).toBeNull();
    expect(r.pass).toBeNull();
  });
});
