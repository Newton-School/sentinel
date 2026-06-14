import { describe, it, expect } from "vitest";
import { normalizeForHash, tokenSet, jaccard, stripProvenanceSuffix } from "../src/memory/textMatch.js";

describe("textMatch.normalizeForHash", () => {
  it("lowercases, strips punctuation, and collapses whitespace", () => {
    expect(normalizeForHash("  Rahul   S.  ")).toBe("rahul s");
    expect(normalizeForHash("Q3 — Placements!!")).toBe("q3 placements");
  });

  it("keeps unicode letters and digits", () => {
    expect(normalizeForHash("Café 2026")).toBe("café 2026");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeForHash("...,;")).toBe("");
  });
});

describe("textMatch.tokenSet", () => {
  it("splits normalized text into a set of tokens", () => {
    expect([...tokenSet("rahul sharma lead")].sort()).toEqual([
      "lead",
      "rahul",
      "sharma",
    ]);
  });

  it("dedupes repeated tokens", () => {
    expect(tokenSet("a a b").size).toBe(2);
  });

  it("is empty for empty input", () => {
    expect(tokenSet("").size).toBe(0);
  });
});

describe("textMatch.jaccard", () => {
  it("is 1 for identical token sets", () => {
    expect(jaccard(tokenSet("rahul sharma"), tokenSet("sharma rahul"))).toBe(1);
  });

  it("is 0 for disjoint sets", () => {
    expect(jaccard(tokenSet("rahul"), tokenSet("priya"))).toBe(0);
  });

  it("is symmetric", () => {
    const a = tokenSet("rahul sharma lead");
    const b = tokenSet("rahul kumar");
    expect(jaccard(a, b)).toBeCloseTo(jaccard(b, a));
  });

  it("returns 0 for two empty sets (no divide-by-zero)", () => {
    expect(jaccard(tokenSet(""), tokenSet(""))).toBe(0);
  });

  it("computes partial overlap correctly", () => {
    // {rahul, sharma} vs {rahul, kumar}: intersection 1, union 3 → 1/3
    expect(jaccard(tokenSet("rahul sharma"), tokenSet("rahul kumar"))).toBeCloseTo(
      1 / 3
    );
  });
});

describe("textMatch.stripProvenanceSuffix", () => {
  it("strips a trailing provenance parenthetical (with or without end punctuation)", () => {
    expect(
      stripProvenanceSuffix('Rahul\'s rating was "exceeds expectations" (stated by Dipesh, 2026-06-15).')
    ).toBe('Rahul\'s rating was "exceeds expectations"');
    expect(
      stripProvenanceSuffix("Placements weekly target is 50 offers (corrected by Dipesh on 2026-06-14)")
    ).toBe("Placements weekly target is 50 offers");
  });

  it("leaves a meaningful (non-provenance) trailing parenthetical intact", () => {
    expect(stripProvenanceSuffix("Q3 target is 250 offers (across all campuses)")).toBe(
      "Q3 target is 250 offers (across all campuses)"
    );
  });

  it("returns the original text when there is no trailing parenthetical", () => {
    expect(stripProvenanceSuffix("Rahul Sharma leads the placements team")).toBe(
      "Rahul Sharma leads the placements team"
    );
  });

  it("does not strip down to empty (a fact that is only provenance is kept)", () => {
    expect(stripProvenanceSuffix("(stated by Dipesh)")).toBe("(stated by Dipesh)");
  });
});
