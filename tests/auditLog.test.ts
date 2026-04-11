import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Mock config module
vi.mock("../src/config.js", () => ({
  config: {
    SQLITE_DB_PATH: ":memory:",
    LOG_LEVEL: "silent",
  },
}));

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// We need to mock the DB module to use an in-memory DB we control
let testDb: Database.Database;

vi.mock("../src/state/db.js", () => ({
  getDb: () => testDb,
}));

// Mock upsertTrait since we're testing trackQuery, not trait logic
vi.mock("../src/persona/store.js", () => ({
  upsertTrait: vi.fn(),
}));

import { trackQuery } from "../src/persona/tracker.js";

function setupTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      query_text TEXT NOT NULL,
      category TEXT,
      created_at TEXT NOT NULL,
      response_text TEXT,
      response_duration_ms INTEGER,
      sources_used TEXT
    );

    CREATE TABLE IF NOT EXISTS personas (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persona_traits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      label TEXT NOT NULL,
      value TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, label, value)
    );
  `);
  return db;
}

describe("audit logging", () => {
  beforeEach(() => {
    testDb = setupTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  describe("query_log schema", () => {
    it("has response_text column", () => {
      const columns = testDb.pragma("table_info(query_log)") as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("response_text");
    });

    it("has response_duration_ms column", () => {
      const columns = testDb.pragma("table_info(query_log)") as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("response_duration_ms");
    });

    it("has sources_used column", () => {
      const columns = testDb.pragma("table_info(query_log)") as Array<{ name: string }>;
      const names = columns.map((c) => c.name);
      expect(names).toContain("sources_used");
    });
  });

  describe("trackQuery", () => {
    it("stores query text and response text", () => {
      trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "What are the placement numbers?",
        responseText: "Placements are up 15% this month.",
        responseDurationMs: 5000,
      });

      const row = testDb.prepare("SELECT * FROM query_log WHERE user_id = ?").get("U123") as Record<string, unknown>;
      expect(row.query_text).toBe("What are the placement numbers?");
      expect(row.response_text).toBe("Placements are up 15% this month.");
      expect(row.response_duration_ms).toBe(5000);
    });

    it("stores sources_used as JSON", () => {
      trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "What are the placement numbers?",
        responseText: "Answer here",
        sourcesUsed: ["Metabase", "Slack"],
      });

      const row = testDb.prepare("SELECT * FROM query_log WHERE user_id = ?").get("U123") as Record<string, unknown>;
      expect(row.sources_used).toBe(JSON.stringify(["Metabase", "Slack"]));
    });

    it("stores null for optional fields when not provided", () => {
      trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "Give me an update",
      });

      const row = testDb.prepare("SELECT * FROM query_log WHERE user_id = ?").get("U123") as Record<string, unknown>;
      expect(row.response_text).toBeNull();
      expect(row.response_duration_ms).toBeNull();
      expect(row.sources_used).toBeNull();
    });

    it("categorizes the query and stores category", () => {
      trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "How are admissions looking?",
        responseText: "Admissions are steady.",
      });

      const row = testDb.prepare("SELECT * FROM query_log WHERE user_id = ?").get("U123") as Record<string, unknown>;
      expect(row.category).toBe("admissions");
    });

    it("stores created_at timestamp", () => {
      trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "hello",
      });

      const row = testDb.prepare("SELECT * FROM query_log WHERE user_id = ?").get("U123") as Record<string, unknown>;
      expect(row.created_at).toBeTruthy();
      // Should be a valid ISO date
      expect(() => new Date(row.created_at as string)).not.toThrow();
    });
  });
});
