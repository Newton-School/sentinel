import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

describe("database migrations", () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.resetModules();
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("adds response audit columns to a fresh database", async () => {
    // Mock config to use our in-memory db path (getDb creates its own)
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    const testDb = getDb();

    const columns = testDb.pragma("table_info(query_log)") as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain("response_text");
    expect(columnNames).toContain("response_duration_ms");
    expect(columnNames).toContain("sources_used");

    // Also verify original columns still exist
    expect(columnNames).toContain("user_id");
    expect(columnNames).toContain("query_text");
    expect(columnNames).toContain("category");
    expect(columnNames).toContain("created_at");

    closeDb();
  });

  it("migration is idempotent — running twice does not error", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    // First call runs migrations
    const db1 = getDb();
    closeDb();

    // Reset module to force re-initialization
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

    // Second call should also succeed without duplicate column errors
    const mod2 = await import("../src/state/db.js");
    expect(() => mod2.getDb()).not.toThrow();
    mod2.closeDb();
  });

  it("creates all three tables", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    const testDb = getDb();

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("personas");
    expect(tableNames).toContain("persona_traits");
    expect(tableNames).toContain("query_log");

    closeDb();
  });
});
