import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as personaStoreRace.test.ts / dbMigration.test.ts).
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

describe("joinStore (persistent Meet-watcher join dedup)", () => {
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

  it("markJoined then getJoinedIds returns the id", async () => {
    const { markJoined, getJoinedIds } = await import(
      "../src/meet-bot/joinStore.js"
    );

    const now = Date.now();
    markJoined("evt-1", now);

    const ids = getJoinedIds(now - 1000);
    expect(ids.has("evt-1")).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("a second markJoined for the same id does not throw and updates joined_at", async () => {
    const { markJoined, getJoinedIds } = await import(
      "../src/meet-bot/joinStore.js"
    );
    const { getDb } = await import("../src/state/db.js");

    const t1 = 1_000_000;
    const t2 = 2_000_000;

    markJoined("evt-dup", t1);
    expect(() => markJoined("evt-dup", t2)).not.toThrow();

    // Only one row exists, with the updated timestamp.
    const rows = getDb()
      .prepare("SELECT event_id, joined_at FROM joined_meetings")
      .all() as Array<{ event_id: string; joined_at: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe("evt-dup");
    expect(rows[0].joined_at).toBe(t2);

    // Still discoverable from getJoinedIds.
    expect(getJoinedIds(t2).has("evt-dup")).toBe(true);
  });

  it("getJoinedIds(cutoff) excludes rows older than the cutoff", async () => {
    const { markJoined, getJoinedIds } = await import(
      "../src/meet-bot/joinStore.js"
    );

    const now = 10_000_000;
    const cutoff = now - 4 * 60 * 60 * 1000; // 4h TTL window

    markJoined("recent", now - 1000);
    markJoined("old", cutoff - 1);
    markJoined("boundary", cutoff); // joined_at >= cutoff is included

    const ids = getJoinedIds(cutoff);
    expect(ids.has("recent")).toBe(true);
    expect(ids.has("boundary")).toBe(true);
    expect(ids.has("old")).toBe(false);
  });

  it("purgeJoined deletes old rows and keeps recent ones", async () => {
    const { markJoined, getJoinedIds, purgeJoined } = await import(
      "../src/meet-bot/joinStore.js"
    );
    const { getDb } = await import("../src/state/db.js");

    const now = 10_000_000;
    const cutoff = now - 4 * 60 * 60 * 1000;

    markJoined("recent", now - 1000);
    markJoined("old", cutoff - 1);
    markJoined("boundary", cutoff);

    purgeJoined(cutoff);

    const remaining = getDb()
      .prepare("SELECT event_id FROM joined_meetings ORDER BY event_id")
      .all() as Array<{ event_id: string }>;
    const remainingIds = remaining.map((r) => r.event_id);

    // Rows strictly older than cutoff are deleted; boundary (== cutoff) kept.
    expect(remainingIds).toContain("recent");
    expect(remainingIds).toContain("boundary");
    expect(remainingIds).not.toContain("old");

    // getJoinedIds reflects the same view post-purge.
    const ids = getJoinedIds(cutoff);
    expect(ids.has("recent")).toBe(true);
    expect(ids.has("boundary")).toBe(true);
    expect(ids.has("old")).toBe(false);
  });

  it("markJoined defaults to Date.now() when no time is provided", async () => {
    const { markJoined, getJoinedIds } = await import(
      "../src/meet-bot/joinStore.js"
    );

    const before = Date.now();
    markJoined("evt-default");
    const ids = getJoinedIds(before - 1000);
    expect(ids.has("evt-default")).toBe(true);
  });
});
