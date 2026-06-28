import { describe, it, expect } from "vitest";
import { normalizeText, tokenSetSimilarity, factMatches, scoreFacts } from "../evals/score.js";

describe("normalizeText", () => {
  it("lowercases, collapses whitespace, strips surrounding punctuation", () => {
    expect(normalizeText("  Launch  the   Page!! ")).toBe("launch the page");
  });
});

describe("tokenSetSimilarity", () => {
  it("is 1 for identical token sets and 0 for disjoint", () => {
    expect(tokenSetSimilarity("alpha beta", "beta alpha")).toBe(1);
    expect(tokenSetSimilarity("alpha", "omega")).toBe(0);
  });
  it("is a Jaccard ratio for partial overlap", () => {
    // {a,b,c} vs {a,b,d} → ∩=2, ∪=4 → 0.5
    expect(tokenSetSimilarity("a b c", "a b d")).toBeCloseTo(0.5, 5);
  });
  it("returns 0 when either side is empty", () => {
    expect(tokenSetSimilarity("", "a")).toBe(0);
  });
});

describe("factMatches", () => {
  const expected = { text: "Launch the pricing page on July 15", category: "decision", entities: ["pricing page"] };

  it("matches when category agrees and text is similar enough", () => {
    expect(
      factMatches(expected, { text: "Launch pricing page on July 15", category: "decision" }, { textThreshold: 0.6 })
    ).toBe(true);
  });

  it("rejects when the category differs", () => {
    expect(
      factMatches(expected, { text: "Launch the pricing page on July 15", category: "owner" }, { textThreshold: 0.6 })
    ).toBe(false);
  });

  it("rejects when text similarity is below threshold", () => {
    expect(
      factMatches(expected, { text: "The cafeteria menu changed", category: "decision" }, { textThreshold: 0.6 })
    ).toBe(false);
  });
});

describe("scoreFacts", () => {
  const cat = (text: string, category = "decision") => ({ text, category });

  it("scores a perfect match as precision/recall/f1 = 1", () => {
    const r = scoreFacts([cat("launch on july 15")], [cat("launch on july 15")]);
    expect(r).toMatchObject({ precision: 1, recall: 1, f1: 1, truePositives: 1, falsePositives: 0, falseNegatives: 0 });
  });

  it("penalizes a missed expected fact (lower recall)", () => {
    const r = scoreFacts([cat("a alpha beta"), cat("b gamma delta")], [cat("a alpha beta")]);
    expect(r.truePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.recall).toBeCloseTo(0.5, 5);
    expect(r.precision).toBe(1);
  });

  it("penalizes a spurious actual fact (lower precision)", () => {
    const r = scoreFacts([cat("a alpha beta")], [cat("a alpha beta"), cat("z spurious thing")]);
    expect(r.truePositives).toBe(1);
    expect(r.falsePositives).toBe(1);
    expect(r.precision).toBeCloseTo(0.5, 5);
    expect(r.recall).toBe(1);
  });

  it("does not double-count one actual against two expected", () => {
    const r = scoreFacts([cat("launch july 15"), cat("launch july 15")], [cat("launch july 15")]);
    expect(r.truePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
  });

  it("treats two empty sets as a perfect score", () => {
    const r = scoreFacts([], []);
    expect(r).toMatchObject({ precision: 1, recall: 1, f1: 1 });
  });

  it("an empty expected set with spurious actuals yields precision 0, recall 1", () => {
    const r = scoreFacts([], [cat("anything")]);
    expect(r.precision).toBe(0);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(0);
  });
});
