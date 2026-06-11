import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery, rankMemories } from "../src/memory/rank.js";
import type { MemoryCandidate } from "../src/memory/types.js";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();
}

function candidate(over: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    id: 1,
    text: "Q3 placement target is 250 offers",
    category: "fact",
    entities: null,
    sourceType: "meeting",
    sourceRef: null,
    sourceLabel: "Growth review",
    speaker: null,
    assertedAt: null,
    evidenceQuote: null,
    confidence: 0.7,
    verified: false,
    visibility: "founders",
    sensitivity: "normal",
    derivedFromMemory: false,
    contentHash: "hash",
    status: "active",
    supersededBy: null,
    createdAt: iso(1),
    updatedAt: iso(1),
    bm: -2,
    ...over,
  };
}

/** Extracts the bare tokens from a sanitized query like `"a" OR "b"`. */
function tokensOf(query: string): string[] {
  return [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("sanitizeFtsQuery", () => {
  it("produces double-quoted lowercase tokens joined with OR", () => {
    const q = sanitizeFtsQuery("Placement offers May");
    expect(q).toMatch(/^"[^"]+"( OR "[^"]+")*$/);
    const tokens = tokensOf(q);
    expect(tokens).toContain("placement");
    expect(tokens).toContain("may");
  });

  it("strips apostrophes without throwing-shaped output", () => {
    const q = sanitizeFtsQuery("what's the co-founder's plan");
    const tokens = tokensOf(q);
    expect(tokens).toContain("founder");
    expect(tokens).toContain("plan");
    // Every token is bare alphanumeric — no quotes, operators or punctuation.
    for (const t of tokens) {
      expect(t).toMatch(/^[\p{L}\p{N}]+$/u);
    }
  });

  it("splits hyphenated phrases into tokens", () => {
    const tokens = tokensOf(sanitizeFtsQuery("lead-to-enrollment numbers"));
    expect(tokens).toContain("lead");
    expect(tokens).toContain("enrollment");
    expect(tokens).toContain("numbers");
  });

  it("drops bare AND / OR / NOT operators from user text", () => {
    const q = sanitizeFtsQuery("placements AND offers OR NOT churn");
    // The only OR occurrences are the joiners between quoted tokens.
    expect(q).not.toMatch(/(^|\s)(AND|NOT)(\s|$)/);
    const tokens = tokensOf(q);
    expect(tokens).not.toContain("and");
    expect(tokens).not.toContain("or");
    expect(tokens).not.toContain("not");
    expect(tokens).toContain("placements");
    expect(tokens).toContain("churn");
  });

  it("strips parentheses and FTS syntax characters", () => {
    const tokens = tokensOf(sanitizeFtsQuery('(urgent) placements* "quoted" NEAR(x, 2) col:value ^caret'));
    for (const t of tokens) {
      expect(t).toMatch(/^[\p{L}\p{N}]+$/u);
    }
    expect(tokens).toContain("urgent");
    expect(tokens).toContain("placements");
  });

  it("handles the FTS-hostile kitchen-sink query", () => {
    const q = sanitizeFtsQuery("what's the Q3 plan — placements/NST?");
    const tokens = tokensOf(q);
    expect(tokens).toContain("plan");
    expect(tokens).toContain("placements");
    expect(tokens).toContain("nst");
    // Stopwords and short tokens are gone.
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("q3");
    expect(tokens).not.toContain("s");
  });

  it("drops stopwords and tokens shorter than 3 chars", () => {
    const tokens = tokensOf(sanitizeFtsQuery("what is the of to a an at it placements"));
    expect(tokens).toEqual(expect.arrayContaining(["placements"]));
    expect(tokens).not.toContain("what");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).not.toContain("at");
  });

  it("returns empty string when nothing significant remains", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
    expect(sanitizeFtsQuery("is the a an of to?!")).toBe("");
  });

  it("expands attrition <-> churn synonyms", () => {
    expect(tokensOf(sanitizeFtsQuery("churn rate"))).toContain("attrition");
    expect(tokensOf(sanitizeFtsQuery("attrition rate"))).toContain("churn");
  });

  it("expands salary <-> ctc <-> package synonyms", () => {
    const fromSalary = tokensOf(sanitizeFtsQuery("average salary"));
    expect(fromSalary).toContain("ctc");
    expect(fromSalary).toContain("package");
    expect(tokensOf(sanitizeFtsQuery("average ctc"))).toContain("salary");
  });

  it("expands placement <-> offers synonyms", () => {
    expect(tokensOf(sanitizeFtsQuery("placement update"))).toContain("offers");
    expect(tokensOf(sanitizeFtsQuery("offers update"))).toContain("placements");
  });

  it("does not duplicate tokens after synonym expansion", () => {
    const tokens = tokensOf(sanitizeFtsQuery("salary ctc salary"));
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("rankMemories", () => {
  it("returns [] for no candidates", () => {
    expect(rankMemories([], NOW)).toEqual([]);
  });

  it("relevance dominates: a better (more negative) bm25 ranks first", () => {
    const weak = candidate({ id: 1, bm: -1 });
    const strong = candidate({ id: 2, bm: -5 });
    const ranked = rankMemories([weak, strong], NOW);
    expect(ranked[0].id).toBe(2);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it("recency half-life: a fresh memory outranks a stale one at equal relevance", () => {
    const fresh = candidate({ id: 1, updatedAt: iso(0) });
    const stale = candidate({ id: 2, updatedAt: iso(180) });
    const ranked = rankMemories([fresh, stale], NOW);
    expect(ranked[0].id).toBe(1);

    // 90-day half-life: at age 90d recency = 0.5, so the recency factor is
    // (0.5 + 0.5*0.5) = 0.75 of the fresh score.
    const day90 = candidate({ id: 3, updatedAt: iso(90) });
    const [a, b] = rankMemories([fresh, day90], NOW);
    expect(a.id).toBe(1);
    expect(b.score / a.score).toBeCloseTo(0.75, 5);
  });

  it("boosts decision, owner and deadline categories by 1.25x", () => {
    const fact = candidate({ id: 1, category: "fact" });
    const decision = candidate({ id: 2, category: "decision" });
    const owner = candidate({ id: 3, category: "owner" });
    const deadline = candidate({ id: 4, category: "deadline" });
    const metric = candidate({ id: 5, category: "metric" });

    const ranked = rankMemories([fact, decision, owner, deadline, metric], NOW);
    const top3 = ranked.slice(0, 3).map((r) => r.id).sort();
    expect(top3).toEqual([2, 3, 4]);
    expect(ranked[0].score / ranked[4].score).toBeCloseTo(1.25, 5);
  });

  it("damps low-confidence memories", () => {
    const sure = candidate({ id: 1, confidence: 1.0 });
    const unsure = candidate({ id: 2, confidence: 0.2 });
    const ranked = rankMemories([sure, unsure], NOW);
    expect(ranked[0].id).toBe(1);
    // (0.5 + 0.5*0.2) / (0.5 + 0.5*1.0) = 0.6
    expect(ranked[1].score / ranked[0].score).toBeCloseTo(0.6, 5);
  });

  it("caps results at k (default 6)", () => {
    const many = Array.from({ length: 10 }, (_, i) => candidate({ id: i + 1, bm: -(i + 1) }));
    expect(rankMemories(many, NOW)).toHaveLength(6);
    expect(rankMemories(many, NOW, 3)).toHaveLength(3);
    // Best bm (-10) first.
    expect(rankMemories(many, NOW, 3)[0].id).toBe(10);
  });

  it("treats a malformed updatedAt as fresh rather than fully decayed", () => {
    const broken = candidate({ id: 1, updatedAt: "not-a-date" });
    const fresh = candidate({ id: 2, updatedAt: iso(0) });
    const ranked = rankMemories([broken, fresh], NOW);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 5);
  });

  it("LIKE-fallback degenerate case: constant bm degrades to recency x category x confidence", () => {
    const freshFact = candidate({ id: 1, bm: -1, updatedAt: iso(0), category: "fact" });
    const staleDecision = candidate({ id: 2, bm: -1, updatedAt: iso(300), category: "decision" });
    const freshDecision = candidate({ id: 3, bm: -1, updatedAt: iso(0), category: "decision" });
    const ranked = rankMemories([freshFact, staleDecision, freshDecision], NOW);
    expect(ranked[0].id).toBe(3);
  });
});
