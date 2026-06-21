import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pg from "pg";
// memorySql is pure (pool/handle-parameterized, no config/logger imports), so a
// static import is safe even though src/state/db.js is imported dynamically
// after the per-test config mock.
import { insertFact, searchCandidates } from "../src/memory/memorySql.js";

// Mock pino (same pattern as personaStore.test.ts)
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

/**
 * Cross-connection visibility for the organizational memory store.
 *
 * The SQLite era proved cross-PROCESS file sharing/locking: the main process
 * (real migrations) and the separate memory MCP server (its own pg Pool, no
 * migrations) had to see each other's writes on one db file. Postgres is a
 * server, not a file, so that whole concern — WAL
 * journal mode, busy_timeout, the `sqlite_master` missing-table startup guard,
 * the "open a file without running migrations creates no schema" semantics — is
 * N/A and was DROPPED (see report).
 *
 * The surviving, still-meaningful intent is the SAME one the SQLite test
 * asserted at the application level: a fact written through one connection is
 * visible to a different, independent connection to the same database. On
 * Postgres that means two separate pg Pools to the per-worker test DB. We open
 * both as genuinely independent pools (the way the main app and the per-request
 * memory MCP subprocess each bind their own pool to the same DATABASE_URL) and
 * check that a COMMITTED write on one is readable on the other, in both
 * directions.
 */
describe("memory store across separate Postgres connections (main process + memory MCP server)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    // Build the schema once via the canonical singleton, then reset to a clean
    // slate. The two pools below are separate from this singleton — they only
    // need the schema to already exist.
    const { initDb } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();

    // Two genuinely independent connection pools to the same database — the
    // Postgres analogue of the main process and the memory MCP server each
    // owning their own handle to the shared store.
    poolA = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(async () => {
    await poolA.end();
    await poolB.end();
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("connection B sees a fact written (and committed) by connection A", async () => {
    // Connection A: the main-process analogue writes a fact.
    const written = await insertFact(poolA, {
      text: "Q3 placement target is 250 offers",
      category: "decision",
      sourceType: "meeting",
      sourceLabel: "Growth review",
    });

    // Connection B: a wholly separate pool searches and finds it.
    const hits = await searchCandidates(poolB, '"placement" OR "offers"');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(written.id);
    expect(hits[0].text).toBe("Q3 placement target is 250 offers");
  });

  it("a fact written via connection B (memory_store path) is visible to connection A", async () => {
    // The exact write shape memory_store uses, on the second pool.
    const result = await insertFact(poolB, {
      text: "Admissions funnel conversion is 14 percent",
      category: "metric",
      sourceType: "manual",
      sourceLabel: "Stored on request via Slack",
      confidence: 0.9,
    });
    expect(result.deduped).toBe(false);

    const hits = await searchCandidates(poolA, '"admissions" OR "funnel"');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(result.id);
    expect(hits[0].sourceType).toBe("manual");
    expect(hits[0].sourceLabel).toBe("Stored on request via Slack");
    expect(hits[0].confidence).toBe(0.9);
  });
});
