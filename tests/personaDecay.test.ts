import { describe, it, expect } from "vitest";
import {
  decayedConfidence,
  DECAY_HALF_LIFE_DAYS,
} from "../src/persona/personaDecay.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString();
}

describe("decayedConfidence", () => {
  const now = new Date("2026-06-02T00:00:00Z");

  it("does not decay a trait updated at ~now", () => {
    const updatedAt = now.toISOString();
    expect(decayedConfidence(0.8, updatedAt, now)).toBeCloseTo(0.8, 10);
  });

  it("does not decay a trait updated a few seconds ago", () => {
    const updatedAt = new Date(now.getTime() - 5000).toISOString();
    expect(decayedConfidence(0.8, updatedAt, now)).toBeCloseTo(0.8, 4);
  });

  it("halves confidence after exactly one half-life", () => {
    const updatedAt = isoDaysAgo(now, DECAY_HALF_LIFE_DAYS);
    expect(decayedConfidence(0.8, updatedAt, now)).toBeCloseTo(0.4, 6);
  });

  it("quarters confidence after two half-lives", () => {
    const updatedAt = isoDaysAgo(now, DECAY_HALF_LIFE_DAYS * 2);
    expect(decayedConfidence(0.8, updatedAt, now)).toBeCloseTo(0.2, 6);
  });

  it("decays monotonically toward 0 as age grows", () => {
    const fresh = decayedConfidence(0.9, isoDaysAgo(now, 1), now);
    const mid = decayedConfidence(0.9, isoDaysAgo(now, 30), now);
    const old = decayedConfidence(0.9, isoDaysAgo(now, 120), now);
    expect(fresh).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
  });

  it("never returns a value below 0", () => {
    const ancient = isoDaysAgo(now, 100000);
    const result = decayedConfidence(0.95, ancient, now);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(0.001);
  });

  it("keeps a fresh high-confidence trait high (above the 0.6 prompt threshold)", () => {
    const updatedAt = isoDaysAgo(now, 2);
    expect(decayedConfidence(0.95, updatedAt, now)).toBeGreaterThan(0.6);
  });

  it("drops a borderline trait below the 0.6 threshold once it is stale enough", () => {
    // 0.65 confidence after one half-life -> ~0.325, below 0.6
    const updatedAt = isoDaysAgo(now, DECAY_HALF_LIFE_DAYS);
    expect(decayedConfidence(0.65, updatedAt, now)).toBeLessThan(0.6);
  });

  it("treats a future updatedAt as no decay (clamps negative age to 0)", () => {
    const future = new Date(now.getTime() + 10 * DAY_MS).toISOString();
    expect(decayedConfidence(0.8, future, now)).toBeCloseTo(0.8, 10);
  });

  it("returns 0 when confidence is 0 regardless of age", () => {
    expect(decayedConfidence(0, isoDaysAgo(now, 10), now)).toBe(0);
  });
});
