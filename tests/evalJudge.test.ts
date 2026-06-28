import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
vi.mock("../src/config.js", () => ({ config: { LOG_LEVEL: "silent" } }));

import { judgeAnswer, judgeExtraction, judgePromptVersionId } from "../evals/judge.js";

function judgeResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "",
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    }),
  } as unknown as Response;
}

describe("evals/judge", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parses a judge verdict and clamps the score to [0,1]", async () => {
    const fetchImpl = (async () => judgeResponse({ score: 1.4, pass: true, rationale: "great" })) as unknown as typeof fetch;
    const r = await judgeAnswer({
      question: "What is MRR?",
      candidate: "MRR is ₹50L, per Metabase.",
      rubric: ["cites a source", "gives a number"],
      deps: { apiKey: "k", fetchImpl, now: () => 0 },
    });
    expect(r).not.toBeNull();
    expect(r!.score).toBe(1); // clamped
    expect(r!.pass).toBe(true);
    expect(r!.rationale).toBe("great");
  });

  it("returns null (skipped) when there is no API key", async () => {
    const r = await judgeAnswer({
      question: "q",
      candidate: "c",
      rubric: ["x"],
      deps: { now: () => 0 },
    });
    expect(r).toBeNull();
  });

  it("returns null when the verdict shape is invalid", async () => {
    const fetchImpl = (async () => judgeResponse({ score: "high" })) as unknown as typeof fetch;
    const r = await judgeAnswer({ question: "q", candidate: "c", rubric: ["x"], deps: { apiKey: "k", fetchImpl, now: () => 0 } });
    expect(r).toBeNull();
  });

  it("judges extraction quality and includes expected vs actual in the prompt", async () => {
    let sentUser = "";
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentUser = JSON.parse(init.body as string).messages[1].content;
      return judgeResponse({ score: 0.8, pass: true, rationale: "ok" });
    }) as unknown as typeof fetch;
    const r = await judgeExtraction({
      content: "We launch July 15.",
      expected: [{ text: "Launch July 15", category: "decision" }],
      actual: [{ text: "Launch on July 15", category: "decision" }],
      deps: { apiKey: "k", fetchImpl, now: () => 0 },
    });
    expect(r!.score).toBe(0.8);
    expect(sentUser).toContain("EXPECTED FACTS");
    expect(sentUser).toContain("EXTRACTED FACTS");
  });

  it("exposes a versioned judge prompt id", () => {
    expect(judgePromptVersionId()).toMatch(/^judge@1\.0\.0\+[0-9a-f]{12}$/);
  });
});
