import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// memorySql is pure (db-handle-parameterized, no config/logger imports), so a
// static import is safe even though src/state/db.js is imported dynamically
// after the per-test config mock.
import { insertFact, searchCandidates } from "../src/memory/memorySql.js";

// Mock pino (same pattern as memoryStore.test.ts)
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
 * Opens a second connection to the database file exactly the way the memory
 * MCP server does (src/mcp/memory.ts): its own better-sqlite3 handle, WAL +
 * busy_timeout pragmas, and NO migrations — the main process owns the schema.
 */
function openServerConnection(path: string): Database.Database {
  const conn = new Database(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("busy_timeout = 5000");
  return conn;
}

/** The startup guard query the memory MCP server runs (src/mcp/memory.ts). */
function memoriesTableExists(conn: Database.Database): boolean {
  const row = conn
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
    .get();
  return row !== undefined;
}

// These tests are specifically about CROSS-CONNECTION behavior, so they use a
// real temp-file database (":memory:" databases are private to one handle).
describe("memory store across separate connections (main process + memory MCP server)", () => {
  let dir: string;
  let dbPath: string;
  const serverConns: Database.Database[] = [];

  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), "sentinel-mem-mp-"));
    dbPath = join(dir, "sentinel.db");
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: dbPath, LOG_LEVEL: "silent" },
    }));
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
    for (const conn of serverConns.splice(0)) {
      try {
        conn.close();
      } catch {
        // already closed
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("connection B (server-style, no migrations) sees a fact written by connection A (main, real migrations)", async () => {
    // Connection A: the main process — getDb() runs the real migrations.
    const { getDb } = await import("../src/state/db.js");
    const a = getDb();
    const written = insertFact(a, {
      text: "Q3 placement target is 250 offers",
      category: "decision",
      sourceType: "meeting",
      sourceLabel: "Growth review",
    });

    // Connection B: a fresh handle on the same file, server-style.
    const b = openServerConnection(dbPath);
    serverConns.push(b);
    expect(b.pragma("busy_timeout", { simple: true })).toBe(5000);

    const hits = searchCandidates(b, '"placement" OR "offers"');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(written.id);
    expect(hits[0].text).toBe("Q3 placement target is 250 offers");
  });

  it("a fact written via connection B (memory_store path) is visible to connection A", async () => {
    const { getDb } = await import("../src/state/db.js");
    const a = getDb();

    const b = openServerConnection(dbPath);
    serverConns.push(b);

    // The exact write shape memory_store uses.
    const result = insertFact(b, {
      text: "Admissions funnel conversion is 14 percent",
      category: "metric",
      sourceType: "manual",
      sourceLabel: "Stored on request via Slack",
      confidence: 0.9,
    });
    expect(result.deduped).toBe(false);

    const hits = searchCandidates(a, '"admissions" OR "funnel"');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(result.id);
    expect(hits[0].sourceType).toBe("manual");
    expect(hits[0].sourceLabel).toBe("Stored on request via Slack");
    expect(hits[0].confidence).toBe(0.9);
  });

  it("the missing-table startup guard detects an uninitialized database (and a migrated one)", async () => {
    // A second, EMPTY temp DB file that the main process never migrated:
    // opening it server-style must NOT create any schema, and the guard query
    // must report the memories table as absent.
    const emptyPath = join(dir, "uninitialized.db");
    const b = openServerConnection(emptyPath);
    serverConns.push(b);
    expect(memoriesTableExists(b)).toBe(false);

    // On the migrated file the same guard finds the table.
    const { getDb } = await import("../src/state/db.js");
    getDb();
    const c = openServerConnection(dbPath);
    serverConns.push(c);
    expect(memoriesTableExists(c)).toBe(true);
  });
});
