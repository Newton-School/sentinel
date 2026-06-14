import { describe, it, expect } from "vitest";
import { fuseCandidates, rankHybrid, HYBRID_ALPHA } from "../src/memory/rank.js";
import type { MemoryCandidate } from "../src/memory/types.js";

function cand(over: Partial<MemoryCandidate>): MemoryCandidate {
  return {
    id: 1, text: "f", category: "fact", entities: null, sourceType: "manual",
    sourceRef: null, sourceLabel: null, speaker: null, assertedAt: "2026-06-10T00:00:00.000Z",
    evidenceQuote: null, confidence: 0.7, verified: false, visibility: "founders",
    sensitivity: "normal", derivedFromMemory: false, contentHash: "h", status: "active",
    supersededBy: null, createdAt: "2026-06-10T00:00:00.000Z", updatedAt: "2026-06-10T00:00:00.000Z",
    bm: -1, ...over,
  };
}

const now = new Date("2026-06-12T00:00:00.000Z");

describe("fuseCandidates", () => {
  it("unions by id: a shared candidate keeps fts bm and gains semantic cos", () => {
    const fts = [cand({ id: 1, bm: -2 }), cand({ id: 2, bm: -1 })];
    const semantic = [cand({ id: 1, bm: 0, cos: 0.9 }), cand({ id: 3, bm: 0, cos: 0.8 })];
    const fused = fuseCandidates(fts, semantic);
    const byId = new Map(fused.map((c) => [c.id, c]));
    expect(byId.get(1)).toMatchObject({ bm: -2, cos: 0.9 }); // fts bm + semantic cos
    expect(byId.get(2)!.cos).toBeUndefined(); // fts-only
    expect(byId.get(3)).toMatchObject({ bm: 0, cos: 0.8 }); // semantic-only
    expect(fused).toHaveLength(3);
  });
});

describe("rankHybrid", () => {
  it("lets a semantic-only candidate outrank a weak BM25 hit (α lexical-leaning)", () => {
    // A: strong fts (-bm=1.0); C: weak fts (-bm=0.2); B: semantic-only (cos high)
    const fused = fuseCandidates(
      [cand({ id: 1, bm: -1.0 }), cand({ id: 3, bm: -0.2 })],
      [cand({ id: 2, bm: 0, cos: 0.9 })]
    );
    const ranked = rankHybrid(fused, now, 6);
    const order = ranked.map((r) => r.id);
    expect(order.indexOf(1)).toBeLessThan(order.indexOf(2)); // strong fts beats semantic
    expect(order.indexOf(2)).toBeLessThan(order.indexOf(3)); // semantic beats weak fts
  });

  it("handles a single candidate without divide-by-zero", () => {
    const ranked = rankHybrid([cand({ id: 1, bm: -1, cos: 0.5 })], now, 6);
    expect(ranked).toHaveLength(1);
    expect(Number.isFinite(ranked[0].score)).toBe(true);
  });

  it("still applies recency — a stale strong hit can lose to a fresh one", () => {
    const fresh = cand({ id: 1, bm: -1, updatedAt: "2026-06-12T00:00:00.000Z" });
    const stale = cand({ id: 2, bm: -1, updatedAt: "2025-06-12T00:00:00.000Z" });
    const ranked = rankHybrid([stale, fresh], now, 6);
    expect(ranked[0].id).toBe(1);
  });

  it("exposes a lexical-leaning alpha", () => {
    expect(HYBRID_ALPHA).toBeGreaterThan(0.5);
    expect(HYBRID_ALPHA).toBeLessThan(1);
  });
});
