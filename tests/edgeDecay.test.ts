import { describe, it, expect } from "vitest";
import {
  decayedEdgeConfidence,
  EDGE_HALF_LIFE_DAYS,
  EDGE_DISPLAY_THRESHOLD,
} from "../src/memory/edgeDecay.js";

const now = new Date("2026-06-14T00:00:00.000Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86400000).toISOString();

describe("decayedEdgeConfidence", () => {
  it("does not decay a just-updated edge", () => {
    expect(decayedEdgeConfidence(0.8, now.toISOString(), now)).toBeCloseTo(0.8, 5);
  });

  it("halves confidence after one half-life", () => {
    expect(decayedEdgeConfidence(0.8, daysAgo(EDGE_HALF_LIFE_DAYS), now)).toBeCloseTo(0.4, 5);
  });

  it("decays further with age", () => {
    const c = decayedEdgeConfidence(0.9, daysAgo(EDGE_HALF_LIFE_DAYS * 3), now);
    expect(c).toBeLessThan(0.2);
    expect(c).toBeGreaterThan(0);
  });

  it("treats a future/zero updated_at as no decay", () => {
    expect(decayedEdgeConfidence(0.7, daysAgo(-5), now)).toBeCloseTo(0.7, 5);
  });

  it("exports a sane display threshold", () => {
    expect(EDGE_DISPLAY_THRESHOLD).toBeGreaterThan(0.4);
    expect(EDGE_DISPLAY_THRESHOLD).toBeLessThan(0.9);
  });
});
