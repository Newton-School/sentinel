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

  it("getOrCreatePersona twice for the same user does not throw and returns the same persona", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    const first = getOrCreatePersona("U_RACE", "A");

    let again!: ReturnType<typeof getOrCreatePersona>;
    expect(() => {
      again = getOrCreatePersona("U_RACE", "A");
    }).not.toThrow();

    expect(again.userId).toBe(first.userId);
    expect(again.displayName).toBe(first.displayName);
    expect(again.role).toBe(first.role);
    expect(again.createdAt).toBe(first.createdAt);
    expect(again.updatedAt).toBe(first.updatedAt);
  });

  it("getOrCreatePersona brand-new persona has null role and equal created/updated timestamps", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    const profile = getOrCreatePersona("U_FRESH", "Fresh User");

    expect(profile.role).toBeNull();
    expect(profile.createdAt).toBe(profile.updatedAt);
  });

  it("getOrCreatePersona does NOT overwrite displayName/role on a second call", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    getOrCreatePersona("U_KEEP", "Original Name");

    // Second call with a different display name must NOT overwrite the row.
    const second = getOrCreatePersona("U_KEEP", "Changed Name");

    expect(second.displayName).toBe("Original Name");
    expect(second.role).toBeNull();
  });

  it("getOrCreatePersona preserves the role set after creation when called again", async () => {
    const { getOrCreatePersona } = await import("../src/persona/store.js");
    const { getDb } = await import("../src/state/db.js");

    getOrCreatePersona("U_ROLE", "Role User");

    // Simulate role being assigned elsewhere.
    getDb()
      .prepare("UPDATE personas SET role = ? WHERE user_id = ?")
      .run("admin", "U_ROLE");

    const again = getOrCreatePersona("U_ROLE", "Role User");
    expect(again.role).toBe("admin");
    expect(again.displayName).toBe("Role User");
  });

  it("upsertTrait first call seeds confidence 0.5 and evidence_count 1", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    upsertTrait("U_SEED", "focus_area", "placements");

    const traits = getTraits("U_SEED");
    expect(traits).toHaveLength(1);
    expect(traits[0].confidence).toBeCloseTo(0.5, 10);
    expect(traits[0].evidenceCount).toBe(1);
  });

  it("upsertTrait second call grows confidence to 0.575 and increments evidence_count", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    upsertTrait("U_GROW", "focus_area", "placements");
    expect(() =>
      upsertTrait("U_GROW", "focus_area", "placements")
    ).not.toThrow();

    const traits = getTraits("U_GROW");
    expect(traits).toHaveLength(1);
    // 0.5 + (1 - 0.5) * 0.15 = 0.575
    expect(traits[0].confidence).toBeCloseTo(0.575, 6);
    expect(traits[0].evidenceCount).toBe(2);
  });

  it("upsertTrait third call grows confidence to 0.63875 and evidence_count 3", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    upsertTrait("U_GROW3", "focus_area", "placements");
    upsertTrait("U_GROW3", "focus_area", "placements");
    upsertTrait("U_GROW3", "focus_area", "placements");

    const traits = getTraits("U_GROW3");
    expect(traits).toHaveLength(1);
    // 0.575 + (1 - 0.575) * 0.15 = 0.63875
    expect(traits[0].confidence).toBeCloseTo(0.63875, 6);
    expect(traits[0].evidenceCount).toBe(3);
  });

  it("upsertTrait confidence never exceeds 0.95 after many upserts", async () => {
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    for (let i = 0; i < 100; i++) {
      upsertTrait("U_CEIL", "focus_area", "placements");
    }

    const traits = getTraits("U_CEIL");
    expect(traits).toHaveLength(1);
    expect(traits[0].confidence).toBeLessThanOrEqual(0.95);
    expect(traits[0].confidence).toBeGreaterThan(0.94);
    expect(traits[0].evidenceCount).toBe(100);
  });

  // --- Deterministic "lost race" tests ---------------------------------
  // better-sqlite3 is a single synchronous connection, so a real thread
  // race can't be reproduced. We instead force the lost-race window: the
  // pre-write SELECT reports "no row" even though a conflicting row already
  // exists, so the subsequent write must collide with the PK / UNIQUE
  // constraint. With INSERT ... ON CONFLICT the write survives; a plain
  // check-then-insert throws.

  it("getOrCreatePersona survives a lost-race duplicate INSERT on the PK", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { getOrCreatePersona } = await import("../src/persona/store.js");

    // A row already exists (committed by a concurrent writer).
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO personas (user_id, display_name, role, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?)`
      )
      .run("U_LOSTRACE", "Winner", now, now);

    // Force the lost-race window: any persona SELECT that runs BEFORE the
    // first INSERT in this call reports "no row", so a check-then-insert
    // implementation proceeds to its INSERT and collides with the PK. A
    // read-back SELECT (which runs AFTER the INSERT) is left untouched, so
    // the ON CONFLICT implementation can still return the canonical row.
    const db = getDb();
    const realPrepare = db.prepare.bind(db);
    let insertRan = false;
    const spy = vi
      .spyOn(db, "prepare")
      .mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        if (/^\s*INSERT/i.test(sql)) {
          const realRun = stmt.run.bind(stmt);
          stmt.run = ((...args: unknown[]) => {
            insertRan = true;
            return (realRun as (...a: unknown[]) => unknown)(...args);
          }) as typeof stmt.run;
        }
        if (/^\s*SELECT/i.test(sql) && /FROM personas/i.test(sql)) {
          const realGet = stmt.get.bind(stmt);
          stmt.get = ((...args: unknown[]) =>
            insertRan
              ? (realGet as (...a: unknown[]) => unknown)(...args)
              : undefined) as typeof stmt.get;
        }
        return stmt;
      });

    try {
      // Old plain INSERT would throw a UNIQUE/PK constraint error here.
      expect(() => getOrCreatePersona("U_LOSTRACE", "Loser")).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    // The original row is preserved (no overwrite on conflict).
    const row = getDb()
      .prepare("SELECT * FROM personas WHERE user_id = ?")
      .get("U_LOSTRACE") as { display_name: string; role: string | null };
    expect(row.display_name).toBe("Winner");
    expect(row.role).toBeNull();
  });

  it("upsertTrait survives a lost-race duplicate INSERT on the UNIQUE triple", async () => {
    const { getDb } = await import("../src/state/db.js");
    const { upsertTrait, getTraits } = await import("../src/persona/store.js");

    // A trait row already exists (committed by a concurrent writer).
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
         VALUES (?, ?, ?, 0.5, 1, ?, ?)`
      )
      .run("U_LOSTRACE_T", "focus_area", "placements", now, now);

    // Force the lost-race window for the pre-write SELECT.
    const db = getDb();
    const realPrepare = db.prepare.bind(db);
    const spy = vi
      .spyOn(db, "prepare")
      .mockImplementation((sql: string) => {
        const stmt = realPrepare(sql);
        if (/^\s*SELECT/i.test(sql) && /FROM persona_traits/i.test(sql)) {
          stmt.get = (() => undefined) as typeof stmt.get;
        }
        return stmt;
      });

    try {
      // Old plain INSERT would throw a UNIQUE constraint error here.
      expect(() =>
        upsertTrait("U_LOSTRACE_T", "focus_area", "placements")
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }

    // The conflict was resolved as an UPDATE: still one row, evidence bumped.
    const traits = getTraits("U_LOSTRACE_T");
    expect(traits).toHaveLength(1);
    expect(traits[0].evidenceCount).toBe(2);
    expect(traits[0].confidence).toBeCloseTo(0.575, 6);
  });
});
