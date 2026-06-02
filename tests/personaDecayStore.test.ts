import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as personaStore.test.ts / personaStoreRace.test.ts)
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("getTraitsForPrompt read-time confidence decay", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
  });

  it("reports a lower confidence for a stale trait than its stored value", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { getTraits, getTraitsForPrompt } = await import(
      "../src/persona/store.js"
    );

    // Insert a trait with a very old updated_at directly (bypassing upsert),
    // so the stored confidence is high but the row is stale.
    const created = new Date().toISOString();
    const stale = new Date(Date.now() - 90 * DAY_MS).toISOString();
    getDb()
      .prepare(
        `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
         VALUES (?, ?, ?, 0.9, 5, ?, ?)`
      )
      .run("U_STALE", "focus_area", "placements", created, stale);

    const stored = getTraits("U_STALE");
    const forPrompt = getTraitsForPrompt("U_STALE");

    expect(stored).toHaveLength(1);
    expect(forPrompt).toHaveLength(1);

    // Stored confidence is untouched.
    expect(stored[0].confidence).toBeCloseTo(0.9, 6);
    // Prompt confidence is decayed below the stored value.
    expect(forPrompt[0].confidence).toBeLessThan(0.9);
    expect(forPrompt[0].confidence).toBeGreaterThanOrEqual(0);
  });

  it("leaves a recently-updated trait approximately unchanged", async () => {
    const { upsertTrait, getTraits, getTraitsForPrompt } = await import(
      "../src/persona/store.js"
    );

    upsertTrait("U_FRESH", "focus_area", "placements");

    const stored = getTraits("U_FRESH");
    const forPrompt = getTraitsForPrompt("U_FRESH");

    expect(forPrompt).toHaveLength(1);
    // Fresh trait: decay is negligible.
    expect(forPrompt[0].confidence).toBeCloseTo(stored[0].confidence, 3);
  });

  it("does NOT mutate the stored row (decay is read-time only)", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { getTraitsForPrompt } = await import("../src/persona/store.js");

    const created = new Date().toISOString();
    const stale = new Date(Date.now() - 60 * DAY_MS).toISOString();
    getDb()
      .prepare(
        `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
         VALUES (?, ?, ?, 0.8, 3, ?, ?)`
      )
      .run("U_NOMUT", "focus_area", "finance", created, stale);

    getTraitsForPrompt("U_NOMUT"); // read with decay applied

    const row = getDb()
      .prepare(
        "SELECT confidence, updated_at FROM persona_traits WHERE user_id = ?"
      )
      .get("U_NOMUT") as { confidence: number; updated_at: string };

    expect(row.confidence).toBeCloseTo(0.8, 6);
    expect(row.updated_at).toBe(stale);
  });

  it("reinforcement (upsertTrait) refreshes updated_at and reverses decay", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { upsertTrait, getTraitsForPrompt } = await import(
      "../src/persona/store.js"
    );

    // Seed a stale trait with a high stored confidence.
    const created = new Date().toISOString();
    const stale = new Date(Date.now() - 90 * DAY_MS).toISOString();
    getDb()
      .prepare(
        `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
         VALUES (?, ?, ?, 0.9, 5, ?, ?)`
      )
      .run("U_REINF", "focus_area", "placements", created, stale);

    const decayedBefore = getTraitsForPrompt("U_REINF")[0].confidence;

    // Reinforce: bumps stored confidence AND refreshes updated_at to ~now.
    upsertTrait("U_REINF", "focus_area", "placements");

    const decayedAfter = getTraitsForPrompt("U_REINF")[0].confidence;

    // After reinforcement the freshly-updated trait reports a much higher
    // confidence than the previously-stale one.
    expect(decayedAfter).toBeGreaterThan(decayedBefore);
    expect(decayedAfter).toBeGreaterThan(0.6);
  });

  it("getTraitsForPrompt accepts an injected 'now' for deterministic decay", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { getTraitsForPrompt } = await import("../src/persona/store.js");
    const { DECAY_HALF_LIFE_DAYS } = await import(
      "../src/persona/personaDecay.js"
    );

    const updatedAt = "2026-01-01T00:00:00Z";
    getDb()
      .prepare(
        `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
         VALUES (?, ?, ?, 0.8, 4, ?, ?)`
      )
      .run("U_INJECT", "focus_area", "placements", updatedAt, updatedAt);

    // Exactly one half-life after updatedAt -> confidence halves.
    const now = new Date(
      new Date(updatedAt).getTime() + DECAY_HALF_LIFE_DAYS * DAY_MS
    );
    const forPrompt = getTraitsForPrompt("U_INJECT", now);
    expect(forPrompt[0].confidence).toBeCloseTo(0.4, 6);
  });
});
