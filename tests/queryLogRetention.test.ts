import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Queryable } from "../src/state/db.js";

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/**
 * Insert a query_log row with an explicit created_at ISO timestamp.
 */
async function insertRow(q: Queryable, userId: string, createdAtMs: number): Promise<void> {
  await q.query(
    `INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, "C1", "1.1", "q", "general", new Date(createdAtMs).toISOString()]
  );
}

describe("pruneQueryLog", () => {
  let pruneQueryLog: typeof import("../src/state/db.js").pruneQueryLog;
  let getPool: typeof import("../src/state/db.js").getPool;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-06-02T00:00:00.000Z");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));

    const mod = await import("../src/state/db.js");
    getPool = mod.getPool;
    pruneQueryLog = mod.pruneQueryLog;
    await mod.initDb();
    // Start each test with a clean slate (initDb already ran a prune at init).
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("deletes rows older than the retention window and keeps recent rows", async () => {
    // Old: 100 and 91 days ago (outside a 90-day window)
    await insertRow(getPool(), "U1", NOW - 100 * DAY_MS);
    await insertRow(getPool(), "U2", NOW - 91 * DAY_MS);
    // Recent: 89 days ago and now (inside the window)
    await insertRow(getPool(), "U3", NOW - 89 * DAY_MS);
    await insertRow(getPool(), "U4", NOW);

    const deleted = await pruneQueryLog(90, NOW);

    expect(deleted).toBe(2);

    const remaining = (
      await getPool().query("SELECT user_id FROM query_log ORDER BY user_id")
    ).rows as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U3", "U4"]);
  });

  it("returns 0 when nothing is old enough to prune", async () => {
    await insertRow(getPool(), "U1", NOW - 10 * DAY_MS);
    await insertRow(getPool(), "U2", NOW);

    const deleted = await pruneQueryLog(90, NOW);

    expect(deleted).toBe(0);
    const count = Number(
      ((await getPool().query("SELECT COUNT(*) AS c FROM query_log")).rows[0] as { c: string }).c
    );
    expect(count).toBe(2);
  });

  it("keeps a row exactly at the retention boundary", async () => {
    // Exactly 90 days old should be kept (cutoff is strictly older-than).
    await insertRow(getPool(), "U1", NOW - 90 * DAY_MS);

    const deleted = await pruneQueryLog(90, NOW);

    expect(deleted).toBe(0);
    const count = Number(
      ((await getPool().query("SELECT COUNT(*) AS c FROM query_log")).rows[0] as { c: string }).c
    );
    expect(count).toBe(1);
  });

  it("respects a custom retention window", async () => {
    await insertRow(getPool(), "U1", NOW - 40 * DAY_MS);
    await insertRow(getPool(), "U2", NOW - 20 * DAY_MS);

    const deleted = await pruneQueryLog(30, NOW);

    expect(deleted).toBe(1);
    const remaining = (
      await getPool().query("SELECT user_id FROM query_log")
    ).rows as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U2"]);
  });

  it("defaults retention to 90 days and uses the current time when nowMs is omitted", async () => {
    await insertRow(getPool(), "U_old", Date.now() - 200 * DAY_MS);
    await insertRow(getPool(), "U_new", Date.now());

    const deleted = await pruneQueryLog();

    expect(deleted).toBe(1);
    const remaining = (
      await getPool().query("SELECT user_id FROM query_log")
    ).rows as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U_new"]);
  });
});
