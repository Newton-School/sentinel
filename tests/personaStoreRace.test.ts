import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as personaStore.test.ts / dbMigration.test.ts)
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

describe("persona store race-safety (INSERT ... ON CONFLICT)", () => {
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

  it("getOrCreatePersona twice for the same user does not throw and returns the same persona", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    const first = await getOrCreatePersona("U_RACE", "A");

    // Second call must not reject (idempotent ON CONFLICT path).
    const again = await getOrCreatePersona("U_RACE", "A");

    expect(again.userId).toBe(first.userId);
    expect(again.displayName).toBe(first.displayName);
    expect(again.role).toBe(first.role);
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.updatedAt).toBe(first.updatedAt);
  });

  it("getOrCreatePersona brand-new persona has null role and equal created/updated timestamps", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    const profile = await getOrCreatePersona("U_FRESH", "Fresh User");

    expect(profile.role).toBeNull();
    expect(profile.createdAt).toBe(profile.updatedAt);
  });

  it("getOrCreatePersona does NOT overwrite displayName/role on a second call", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    await getOrCreatePersona("U_KEEP", "Original Name");

    // Second call with a different display name must NOT overwrite the row.
    const second = await getOrCreatePersona("U_KEEP", "Changed Name");

    expect(second.displayName).toBe("Original Name");
    expect(second.role).toBeNull();
  });

  it("getOrCreatePersona preserves the role set after creation when called again", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");
    const { getPool } = await import("../src/state/db.js");

    await getOrCreatePersona("U_ROLE", "Role User");

    // Simulate role being assigned elsewhere.
    await getPool().query("UPDATE personas SET role = $1 WHERE user_id = $2", [
      "admin",
      "U_ROLE",
    ]);

    const again = await getOrCreatePersona("U_ROLE", "Role User");
    expect(again.role).toBe("admin");
    expect(again.displayName).toBe("Role User");
  });

  it("upsertTrait first call seeds confidence 0.5 and evidence_count 1", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    await upsertTrait("U_SEED", "focus_area", "placements");

    const traits = await getTraits("U_SEED");
    expect(traits).toHaveLength(1);
    expect(traits[0].confidence).toBeCloseTo(0.5, 10);
    expect(traits[0].evidenceCount).toBe(1);
  });

  it("upsertTrait second call grows confidence to 0.575 and increments evidence_count", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    await upsertTrait("U_GROW", "focus_area", "placements");
    // Second upsert resolves via ON CONFLICT DO UPDATE (no throw).
    await upsertTrait("U_GROW", "focus_area", "placements");

    const traits = await getTraits("U_GROW");
    expect(traits).toHaveLength(1);
    // 0.5 + (1 - 0.5) * 0.15 = 0.575
    expect(traits[0].confidence).toBeCloseTo(0.575, 6);
    expect(traits[0].evidenceCount).toBe(2);
  });

  it("upsertTrait third call grows confidence to 0.63875 and evidence_count 3", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    await upsertTrait("U_GROW3", "focus_area", "placements");
    await upsertTrait("U_GROW3", "focus_area", "placements");
    await upsertTrait("U_GROW3", "focus_area", "placements");

    const traits = await getTraits("U_GROW3");
    expect(traits).toHaveLength(1);
    // 0.575 + (1 - 0.575) * 0.15 = 0.63875
    expect(traits[0].confidence).toBeCloseTo(0.63875, 6);
    expect(traits[0].evidenceCount).toBe(3);
  });

  it("upsertTrait confidence never exceeds 0.95 after many upserts", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    for (let i = 0; i < 100; i++) {
      await upsertTrait("U_CEIL", "focus_area", "placements");
    }

    const traits = await getTraits("U_CEIL");
    expect(traits).toHaveLength(1);
    expect(traits[0].confidence).toBeLessThanOrEqual(0.95);
    expect(traits[0].confidence).toBeGreaterThan(0.94);
    expect(traits[0].evidenceCount).toBe(100);
  });

  // --- Race-safety under real concurrency -----------------------------
  // The SQLite era forced a synthetic "lost race" window by spying on the
  // single synchronous connection's prepare()/get(). Postgres queries are
  // genuinely concurrent over a pool, so we exercise the real race instead:
  // fire many overlapping INSERT ... ON CONFLICT writes for the same key and
  // assert they converge to exactly one row without throwing — which is the
  // intent the old deterministic tests stood in for.

  it("concurrent getOrCreatePersona calls converge to one row without throwing", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");
    const { getPool } = await import("../src/state/db.js");

    // 20 overlapping first-time creates for the same user. A plain
    // check-then-insert would collide on the PK; ON CONFLICT DO NOTHING is
    // race-safe.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        getOrCreatePersona("U_LOSTRACE", `Name ${i}`)
      )
    );

    // Every concurrent caller resolves to the same canonical (first-written)
    // display name — DO NOTHING preserves whichever insert won.
    const winner = results[0].displayName;
    for (const r of results) {
      expect(r.userId).toBe("U_LOSTRACE");
      expect(r.displayName).toBe(winner);
      expect(r.role).toBeNull();
    }

    const count = (await getPool().query(
      "SELECT COUNT(*)::int AS c FROM personas WHERE user_id = $1",
      ["U_LOSTRACE"]
    )).rows[0] as { c: number };
    expect(count.c).toBe(1);
  });

  it("concurrent upsertTrait calls converge to one row with bumped evidence_count", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");
    const { getPool } = await import("../src/state/db.js");

    // 10 overlapping upserts of the same (user,label,value) triple. A plain
    // check-then-insert would collide on the UNIQUE constraint; ON CONFLICT
    // DO UPDATE resolves each conflict as an evidence-count bump.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        upsertTrait("U_LOSTRACE_T", "focus_area", "placements")
      )
    );

    const traits = await getTraits("U_LOSTRACE_T");
    expect(traits).toHaveLength(1);
    // 10 writes, race-safe: exactly one seed + nine bumps.
    expect(traits[0].evidenceCount).toBe(10);

    const count = (await getPool().query(
      "SELECT COUNT(*)::int AS c FROM persona_traits WHERE user_id = $1",
      ["U_LOSTRACE_T"]
    )).rows[0] as { c: number };
    expect(count.c).toBe(1);
  });
});
