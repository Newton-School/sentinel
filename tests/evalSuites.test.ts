import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
vi.mock("../src/config.js", () => ({ config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" } }));

import { runExtractionCase } from "../evals/extractionEval.js";
import { runAnswerCase } from "../evals/answerEval.js";

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

describe("extraction eval suite", () => {
  beforeEach(() => vi.resetModules());

  it("scores a perfect extraction as precision/recall/f1 = 1 (judge off)", async () => {
    const extractionFacts = {
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
    const fetchImpl = (async () => chatResponse(extractionFacts)) as unknown as typeof fetch;

    const result = await runExtractionCase(
      {
        id: "x1",
        sourceType: "conversation",
        sourceLabel: "T",
        content: "We decided to launch the pricing page on July 15.",
        expected_facts: [{ text: "Launch pricing page July 15", category: "decision", entities: ["pricing page"] }],
      },
      { apiKey: "k", fetchImpl, useJudge: false }
    );

    expect(result.id).toBe("x1");
    expect(result.extracted).toBe(1);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
    expect(result.judge).toBeNull();
  });

  it("reflects a missed fact as reduced recall", async () => {
    const fetchImpl = (async () => chatResponse({ facts: [] })) as unknown as typeof fetch;
    const result = await runExtractionCase(
      {
        id: "x2",
        sourceType: "conversation",
        sourceLabel: "T",
        content: "Priya owns the dashboard.",
        expected_facts: [{ text: "Priya owns the dashboard", category: "owner" }],
      },
      { apiKey: "k", fetchImpl, useJudge: false }
    );
    expect(result.extracted).toBe(0);
    expect(result.recall).toBe(0);
    expect(result.falseNegatives).toBe(1);
  });
});

describe("answer eval suite", () => {
  beforeEach(() => vi.resetModules());

  it("returns the judge's score + pass for a candidate answer", async () => {
    const fetchImpl = (async () => chatResponse({ score: 0.85, pass: true, rationale: "cites Metabase" })) as unknown as typeof fetch;
    const result = await runAnswerCase(
      { id: "a1", question: "What is MRR?", candidate_answer: "₹50L per Metabase.", rubric: ["cites a source"] },
      { apiKey: "k", fetchImpl, now: () => 0 }
    );
    expect(result).toMatchObject({ id: "a1", score: 0.85, pass: true });
  });

  it("returns null score when the judge is skipped (no key)", async () => {
    const result = await runAnswerCase(
      { id: "a2", question: "q", candidate_answer: "c", rubric: ["x"] },
      { now: () => 0 }
    );
    expect(result).toMatchObject({ id: "a2", score: null, pass: null });
  });
});
