import { describe, it, expect } from "vitest";

import { createMessageDeduper } from "../src/slack/dedupe.js";

describe("createMessageDeduper", () => {
  it("returns true the first time a key is seen", () => {
    const deduper = createMessageDeduper();
    expect(deduper.shouldProcess("a")).toBe(true);
  });

  it("returns false for an immediate repeat of the same key", () => {
    const deduper = createMessageDeduper();
    expect(deduper.shouldProcess("a")).toBe(true);
    expect(deduper.shouldProcess("a")).toBe(false);
    expect(deduper.shouldProcess("a")).toBe(false);
  });

  it("treats a different key as new (true)", () => {
    const deduper = createMessageDeduper();
    expect(deduper.shouldProcess("a")).toBe(true);
    expect(deduper.shouldProcess("b")).toBe(true);
    expect(deduper.shouldProcess("a")).toBe(false);
  });

  it("allows a key again once its TTL has elapsed", () => {
    let nowMs = 1000;
    const deduper = createMessageDeduper({ ttlMs: 500, now: () => nowMs });

    expect(deduper.shouldProcess("a")).toBe(true);
    // Still within TTL.
    nowMs = 1400;
    expect(deduper.shouldProcess("a")).toBe(false);
    // TTL elapsed (>= ttlMs since first seen).
    nowMs = 1600;
    expect(deduper.shouldProcess("a")).toBe(true);
  });

  it("size() reflects pruning of expired keys", () => {
    let nowMs = 0;
    const deduper = createMessageDeduper({ ttlMs: 100, now: () => nowMs });

    expect(deduper.shouldProcess("a")).toBe(true);
    nowMs = 50;
    expect(deduper.shouldProcess("b")).toBe(true);
    expect(deduper.size()).toBe(2);

    // Advance past "a"'s TTL but not "b"'s. The next access prunes expired keys.
    nowMs = 120;
    expect(deduper.shouldProcess("c")).toBe(true);
    // "a" pruned (expired), "b" still live, "c" newly added.
    expect(deduper.size()).toBe(2);

    // "a" is now treated as new again, "b" still deduped.
    expect(deduper.shouldProcess("a")).toBe(true);
    expect(deduper.shouldProcess("b")).toBe(false);
  });
});
