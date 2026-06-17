import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

function chatResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "",
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 30 },
    }),
  } as unknown as Response;
}

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
  const runner = await import("../evals/runner.js");
  const store = await import("../evals/store.js");
  return { db, runner, store };
}

const EXTRACTION_OK = {
  facts: [
    {
      text: "Launch the pricing page on July 15.",
      category: "decision",
      entities: ["pricing page"],
      subject: "pricing page",
      confidence: 0.9,
      evidence_quote: "launch the pricing page on July 15",
      sensitivity: "normal",
    },
  ],
};

const EXTRACTION_CASE = {
  id: "x1",
  sourceType: "conversation" as const,
  sourceLabel: "T",
  content: "We decided to launch the pricing page on July 15.",
  expected_facts: [{ text: "Launch pricing page July 15", category: "decision" }],
};

describe("evals/runner parseArgs", () => {
  it("defaults to all suites, no gate, threshold 0.8, judge off", async () => {
    const { runner } = await load();
    expect(runner.parseArgs([])).toMatchObject({ suite: "all", gate: false, threshold: 0.8, useJudge: false });
  });

  it("parses --suite, --gate, --threshold, --judge", async () => {
    const { runner } = await load();
    expect(runner.parseArgs(["--suite", "extraction", "--gate", "--threshold", "0.9", "--judge"])).toMatchObject({
      suite: "extraction",
      gate: true,
      threshold: 0.9,
      useJudge: true,
    });
  });
});

describe("evals/runner runEvals", () => {
  beforeEach(() => vi.resetModules());

  it("scores a perfect extraction suite, persists an eval_runs row, and passes the gate", async () => {
    const { db, runner, store } = await load();
    db.getDb();
    const fetchImpl = (async () => chatResponse(EXTRACTION_OK)) as unknown as typeof fetch;

    const report = await runner.runEvals({
      runId: "run-A",
      ranAt: "2026-06-28T00:00:00.000Z",
      extraction: [EXTRACTION_CASE],
      deps: { apiKey: "k", fetchImpl, useJudge: false },
      threshold: 0.8,
      persist: true,
    });

    expect(report.suites[0].suite).toBe("extraction");
    expect(report.suites[0].meanScore).toBe(1);
    expect(report.suites[0].nPass).toBe(1);
    expect(report.passed).toBe(true);

    const persisted = store.latestEvalRunBySuite("extraction");
    expect(persisted?.runId).toBe("run-A");
    expect(persisted?.promptVersion).toMatch(/^extraction@/);
    db.closeDb();
  });

  it("fails the gate when extraction misses the expected facts", async () => {
    const { db, runner } = await load();
    db.getDb();
    const fetchImpl = (async () => chatResponse({ facts: [] })) as unknown as typeof fetch;
    const report = await runner.runEvals({
      runId: "run-B",
      ranAt: "2026-06-28T00:00:00.000Z",
      extraction: [EXTRACTION_CASE],
      deps: { apiKey: "k", fetchImpl, useJudge: false },
      threshold: 0.8,
      persist: false,
    });
    expect(report.suites[0].meanScore).toBe(0);
    expect(report.passed).toBe(false);
    db.closeDb();
  });

  it("scores an answers suite from judge verdicts", async () => {
    const { db, runner } = await load();
    db.getDb();
    const fetchImpl = (async () => chatResponse({ score: 0.9, pass: true, rationale: "cites a source" })) as unknown as typeof fetch;
    const report = await runner.runEvals({
      runId: "run-C",
      ranAt: "2026-06-28T00:00:00.000Z",
      answers: [{ id: "a1", question: "What is MRR?", candidate_answer: "₹50L per Metabase.", rubric: ["cites a source"] }],
      deps: { apiKey: "k", fetchImpl, now: () => 0 },
      threshold: 0.8,
      persist: false,
    });
    expect(report.suites[0].suite).toBe("answers");
    expect(report.suites[0].meanScore).toBeCloseTo(0.9, 5);
    expect(report.passed).toBe(true);
    db.closeDb();
  });

  it("formatReport renders a PASS/FAIL summary", async () => {
    const { runner } = await load();
    const text = runner.formatReport({
      runId: "r",
      ranAt: "t",
      threshold: 0.8,
      suites: [{ suite: "extraction", nCases: 2, nPass: 2, meanScore: 1, passed: true, cases: [] }],
      passed: true,
    });
    expect(text).toContain("PASS extraction");
    expect(text).toContain("PASSED");
  });
});
