import { describe, it, expect } from "vitest";
import {
  allocateInjection,
  renderMemoryLine,
  DEFAULT_TIER_BUDGET,
} from "../src/claude/injectionBudget.js";
import type { RankedMemory, RetrievalBundle } from "../src/memory/types.js";

function fact(over: Partial<RankedMemory>): RankedMemory {
  return {
    id: 1,
    text: "a fact",
    category: "fact",
    entities: null,
    sourceType: "manual",
    sourceRef: null,
    sourceLabel: null,
    speaker: null,
    assertedAt: "2026-06-10T00:00:00.000Z",
    evidenceQuote: null,
    confidence: 0.7,
    verified: false,
    visibility: "founders",
    sensitivity: "normal",
    derivedFromMemory: false,
    contentHash: "h",
    status: "active",
    supersededBy: null,
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    bm: -1,
    score: 1,
    ...over,
  };
}

function bundle(over: Partial<RetrievalBundle>): RetrievalBundle {
  return { queryFacts: [], entityFacts: [], mentionedEntities: [], ...over };
}

describe("renderMemoryLine", () => {
  it("renders [sourceType, date] text (category) using assertedAt when present", () => {
    const line = renderMemoryLine(
      fact({ text: "Q3 target is 300", category: "decision", sourceType: "meeting", assertedAt: "2026-06-08T12:00:00.000Z" })
    );
    expect(line).toBe("- [meeting, 2026-06-08] Q3 target is 300 (decision)");
  });
});

describe("allocateInjection", () => {
  it("renders entity facts then query facts, each as a line", () => {
    const plan = allocateInjection(
      bundle({
        entityFacts: [fact({ id: 1, text: "entity fact one" })],
        queryFacts: [fact({ id: 2, text: "query fact one" })],
      })
    );
    expect(plan.entityLines).toHaveLength(1);
    expect(plan.queryLines).toHaveLength(1);
    expect(plan.entityLines[0]).toContain("entity fact one");
  });

  it("drops whole lines in rank order once a tier's budget is exceeded", () => {
    const big = "x".repeat(300);
    const queryFacts = Array.from({ length: 20 }, (_, i) =>
      fact({ id: 100 + i, text: `${i}-${big}` })
    );
    const plan = allocateInjection(bundle({ queryFacts }), {
      entityFacts: 0,
      queryFacts: 700,
      total: 700,
    });
    // Highest-ranked kept, total under budget, not all 20 rendered.
    expect(plan.queryLines.length).toBeGreaterThan(0);
    expect(plan.queryLines.length).toBeLessThan(20);
    expect(plan.queryLines[0]).toContain("0-");
    expect(plan.usedChars).toBeLessThanOrEqual(700);
  });

  it("rolls unused entity-tier headroom into the query tier and bounds the total", () => {
    const big = "y".repeat(200);
    const queryFacts = Array.from({ length: 30 }, (_, i) =>
      fact({ id: 200 + i, text: `${i}-${big}` })
    );
    // entityFacts empty → its 1400 headroom rolls into query; total still caps at 3000.
    const plan = allocateInjection(bundle({ queryFacts }), DEFAULT_TIER_BUDGET);
    expect(plan.entityLines).toHaveLength(0);
    expect(plan.usedChars).toBeLessThanOrEqual(DEFAULT_TIER_BUDGET.total);
    // With ~3000 budget and ~205-char lines, expect well more than the per-tier
    // queryFacts cap alone (1600/205 ≈ 7) would allow.
    expect(plan.queryLines.length).toBeGreaterThan(8);
  });

  it("returns empty plan for an empty bundle", () => {
    const plan = allocateInjection(bundle({}));
    expect(plan.entityLines).toHaveLength(0);
    expect(plan.queryLines).toHaveLength(0);
    expect(plan.usedChars).toBe(0);
  });
});
