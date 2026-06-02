import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

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
function insertRow(db: Database.Database, userId: string, createdAtMs: number): void {
  db.prepare(
    `INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, "C1", "1.1", "q", "general", new Date(createdAtMs).toISOString());
}

describe("pruneQueryLog", () => {
  let getDb: typeof import("../src/state/db.js").getDb;
  let pruneQueryLog: typeof import("../src/state/db.js").pruneQueryLog;
  let closeDb: typeof import("../src/state/db.js").closeDb;
  let db: Database.Database;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-06-02T00:00:00.000Z");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("pino", () => {
      const noop = () => {};
      const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
      const pino = () => logger;
      pino.stdTimeFunctions = { isoTime: () => "" };
      return { default: pino };
    });
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const mod = await import("../src/state/db.js");
    getDb = mod.getDb;
    pruneQueryLog = mod.pruneQueryLog;
    closeDb = mod.closeDb;
    db = getDb();
    // Start each test with a clean slate (getDb already ran a prune at init).
    db.exec("DELETE FROM query_log");
  });

  afterEach(() => {
    closeDb();
  });

  it("deletes rows older than the retention window and keeps recent rows", () => {
    // Old: 100 and 91 days ago (outside a 90-day window)
    insertRow(db, "U1", NOW - 100 * DAY_MS);
    insertRow(db, "U2", NOW - 91 * DAY_MS);
    // Recent: 89 days ago and now (inside the window)
    insertRow(db, "U3", NOW - 89 * DAY_MS);
    insertRow(db, "U4", NOW);

    const deleted = pruneQueryLog(90, NOW);

    expect(deleted).toBe(2);

    const remaining = db
      .prepare("SELECT user_id FROM query_log ORDER BY user_id")
      .all() as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U3", "U4"]);
  });

  it("returns 0 when nothing is old enough to prune", () => {
    insertRow(db, "U1", NOW - 10 * DAY_MS);
    insertRow(db, "U2", NOW);

    const deleted = pruneQueryLog(90, NOW);

    expect(deleted).toBe(0);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM query_log").get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it("keeps a row exactly at the retention boundary", () => {
    // Exactly 90 days old should be kept (cutoff is strictly older-than).
    insertRow(db, "U1", NOW - 90 * DAY_MS);

    const deleted = pruneQueryLog(90, NOW);

    expect(deleted).toBe(0);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM query_log").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("respects a custom retention window", () => {
    insertRow(db, "U1", NOW - 40 * DAY_MS);
    insertRow(db, "U2", NOW - 20 * DAY_MS);

    const deleted = pruneQueryLog(30, NOW);

    expect(deleted).toBe(1);
    const remaining = db
      .prepare("SELECT user_id FROM query_log")
      .all() as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U2"]);
  });

  it("defaults retention to 90 days and uses the current time when nowMs is omitted", () => {
    insertRow(db, "U_old", Date.now() - 200 * DAY_MS);
    insertRow(db, "U_new", Date.now());

    const deleted = pruneQueryLog();

    expect(deleted).toBe(1);
    const remaining = db
      .prepare("SELECT user_id FROM query_log")
      .all() as Array<{ user_id: string }>;
    expect(remaining.map((r) => r.user_id)).toEqual(["U_new"]);
  });
});
