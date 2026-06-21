import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as dbMigration.test.ts)
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

describe("persona store snake_case -> camelCase mapping", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("getOrCreatePersona returns a camelCase profile on the brand-new path", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    const profile = await getOrCreatePersona("U_NEW", "Ada Lovelace");

    expect(profile.userId).toBe("U_NEW");
    expect(profile.displayName).toBe("Ada Lovelace");
    expect(profile.role).toBeNull();
    expect(typeof profile.createdAt).toBe("string");
    expect(typeof profile.updatedAt).toBe("string");
  });

  it("getOrCreatePersona returns a camelCase profile on the existing-row path (second call)", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    // First call creates the row.
    await getOrCreatePersona("U_RETURN", "Grace Hopper");

    // Second call reads the existing row from the DB.
    const profile = await getOrCreatePersona("U_RETURN", "Grace Hopper");

    expect(profile.userId).toBe("U_RETURN");
    expect(profile.displayName).toBe("Grace Hopper");
    expect(profile.displayName).not.toBeUndefined();
    expect(typeof profile.createdAt).toBe("string");
    expect(typeof profile.updatedAt).toBe("string");
    expect(profile.createdAt).not.toBeUndefined();
    expect(profile.updatedAt).not.toBeUndefined();
  });

  it("getTraits returns camelCase traits with a numeric evidenceCount", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    // Two upserts for the same (user, label, value) bumps evidence_count to 2.
    await upsertTrait("U_TRAIT", "focus_area", "placements");
    await upsertTrait("U_TRAIT", "focus_area", "placements");

    const traits = await getTraits("U_TRAIT");

    expect(traits).toHaveLength(1);
    const trait = traits[0];
    expect(trait.userId).toBe("U_TRAIT");
    expect(trait.label).toBe("focus_area");
    expect(trait.value).toBe("placements");
    expect(trait.evidenceCount).toBe(2);
    expect(typeof trait.evidenceCount).toBe("number");
    expect(typeof trait.confidence).toBe("number");
    expect(trait.confidence).toBeGreaterThan(0.5);
    expect(typeof trait.id).toBe("number");
    expect(typeof trait.createdAt).toBe("string");
    expect(typeof trait.updatedAt).toBe("string");
  });
});
