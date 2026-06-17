import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the structured-output client so the judge makes no network call and we
// can inspect the exact user message it builds.
const extractJsonMock = vi.fn();
vi.mock("../src/llm/openaiClient.js", () => ({
  extractJson: (...args: unknown[]) => extractJsonMock(...args),
}));

import { judgeAnswer } from "../evals/judge.js";

describe("judgeAnswer — ground-truth splice", () => {
  beforeEach(() => extractJsonMock.mockReset());

  it("injects the ground-truth value into the user message when provided", async () => {
    extractJsonMock.mockResolvedValue({ score: 1, pass: true, rationale: "ok" });
    await judgeAnswer({
      question: "how many enrollments?",
      candidate: "12,431 enrollments (Metabase / Altius)",
      rubric: ["states a figure matching the ground truth", "cites the warehouse"],
      groundTruth: "12431",
      deps: { apiKey: "k" },
    });
    const opts = extractJsonMock.mock.calls[0][0] as { user: string };
    expect(opts.user).toContain("GROUND TRUTH");
    expect(opts.user).toContain("12431");
    expect(opts.user).toContain("CANDIDATE ANSWER");
    expect(opts.user).toContain("RUBRIC");
  });

  it("omits the ground-truth block when not provided (back-compatible)", async () => {
    extractJsonMock.mockResolvedValue({ score: 0.5, pass: false, rationale: "x" });
    await judgeAnswer({
      question: "q",
      candidate: "a",
      rubric: ["r"],
      deps: { apiKey: "k" },
    });
    const opts = extractJsonMock.mock.calls[0][0] as { user: string };
    expect(opts.user).not.toContain("GROUND TRUTH");
  });

  it("returns the parsed verdict", async () => {
    extractJsonMock.mockResolvedValue({ score: 0.9, pass: true, rationale: "good" });
    const v = await judgeAnswer({
      question: "q",
      candidate: "a",
      rubric: ["r"],
      deps: { apiKey: "k" },
    });
    expect(v).toEqual({ score: 0.9, pass: true, rationale: "good" });
  });
});
