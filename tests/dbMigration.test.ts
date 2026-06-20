import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

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

  it("creates a user_id index on query_log", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    const testDb = getDb();

    // Check via sqlite_master
    const indexes = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='query_log'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_query_log_user_id");

    // Also verify via PRAGMA index_list
    const pragmaIndexes = testDb.pragma("index_list('query_log')") as Array<{ name: string }>;
    expect(pragmaIndexes.map((i) => i.name)).toContain("idx_query_log_user_id");

    closeDb();
  });

  it("creates a created_at index on query_log", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    const testDb = getDb();

    const indexes = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='query_log'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((i) => i.name)).toContain("idx_query_log_created_at");

    closeDb();
  });

  it("creates the joined_meetings table with the expected columns", async () => {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));

    const { getDb, closeDb } = await import("../src/state/db.js");
    const testDb = getDb();

    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("joined_meetings");

    const columns = testDb.pragma(
      "table_info(joined_meetings)"
    ) as Array<{ name: string }>;
    const columnNames = columns.map((c) => c.name);
    expect(columnNames).toContain("event_id");
    expect(columnNames).toContain("joined_at");

    closeDb();
  });

  it("rebuilds llm_calls to drop the legacy 'anthropic' provider (file-backed)", async () => {
    const dbPath = join(
      tmpdir(),
      `sentinel-llm-migrate-${process.pid}-${Math.floor(performance.now())}.db`
    );
    const loadAt = async (path: string) => {
      vi.resetModules();
      vi.doMock("pino", () => {
        const noop = () => {};
        const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
        const pino = () => logger;
        pino.stdTimeFunctions = { isoTime: () => "" };
        return { default: pino };
      });
      vi.doMock("../src/config.js", () => ({
        config: { SQLITE_DB_PATH: path, LOG_LEVEL: "silent" },
      }));
      return import("../src/state/db.js");
    };

    try {
      // Seed an OLD-schema DB: the legacy CHECK + one anthropic + one openai row.
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE llm_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          call_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai')),
          model TEXT NOT NULL,
          operation TEXT NOT NULL CHECK (operation IN ('reply','extract','consolidate','embed','summary')),
          input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, latency_ms INTEGER,
          status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
          error_kind TEXT, num_turns INTEGER, user_id TEXT, prompt_version TEXT,
          created_at TEXT NOT NULL
        );
      `);
      const ins = seed.prepare(
        `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
         VALUES (?, ?, ?, ?, 'reply', 'ok', ?)`
      );
      ins.run("c-a", "t", "anthropic", "claude", "2026-06-01T00:00:00.000Z");
      ins.run("c-o", "t", "openai", "gpt-5.4-mini", "2026-06-02T00:00:00.000Z");
      seed.close();

      // Boot → the migration detects the legacy CHECK and rebuilds the table.
      const m = await loadAt(dbPath);
      const db = m.getDb();

      // Legacy anthropic row dropped; openai row preserved.
      const rows = db.prepare("SELECT provider FROM llm_calls").all() as Array<{ provider: string }>;
      expect(rows).toEqual([{ provider: "openai" }]);

      // The tightened CHECK now rejects anthropic.
      expect(() =>
        db
          .prepare(
            `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
             VALUES ('c2','t','anthropic','claude','reply','ok','2026-06-03T00:00:00.000Z')`
          )
          .run()
      ).toThrow();

      // Indexes were recreated on the rebuilt table.
      const idx = (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='llm_calls'")
          .all() as Array<{ name: string }>
      ).map((i) => i.name);
      expect(idx).toContain("idx_llm_calls_trace");
      expect(idx).toContain("idx_llm_calls_created_at");
      expect(idx).toContain("idx_llm_calls_op_model");

      m.closeDb();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(dbPath + suffix);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  });
});

describe("company brain — entity graph schema", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadFreshDb() {
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
    return import("../src/state/db.js");
  }

  function tableNames(db: Database.Database): string[] {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>
    ).map((t) => t.name);
  }

  function colNames(db: Database.Database, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(
      (c) => c.name
    );
  }

  it("creates the entities table with identity, scoping and embedding columns", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    expect(tableNames(db)).toContain("entities");
    const cols = colNames(db, "entities");
    for (const c of [
      "id",
      "type",
      "canonical_name",
      "normalized_name",
      "aliases",
      "slack_user_id",
      "email",
      "metadata",
      "confidence",
      "visibility",
      "status",
      "merged_into",
      "embedding",
      "source_ref",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(c);
    }
    closeDb();
  });

  it("creates entity_edges with relation, confidence and evidence columns + indexes", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    expect(tableNames(db)).toContain("entity_edges");
    const cols = colNames(db, "entity_edges");
    for (const c of [
      "id",
      "src_id",
      "dst_id",
      "relation",
      "confidence",
      "evidence_count",
      "provenance",
      "asserted_at",
      "status",
      "created_at",
      "updated_at",
    ]) {
      expect(cols).toContain(c);
    }

    const idx = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='entity_edges'"
        )
        .all() as Array<{ name: string }>
    ).map((i) => i.name);
    expect(idx).toContain("idx_edges_src");
    expect(idx).toContain("idx_edges_dst");
    closeDb();
  });

  it("creates memory_entities join table keyed by (memory_id, entity_id, role)", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    expect(tableNames(db)).toContain("memory_entities");
    const cols = colNames(db, "memory_entities");
    for (const c of ["memory_id", "entity_id", "role", "confidence", "created_at"]) {
      expect(cols).toContain(c);
    }
    closeDb();
  });

  it("creates dossier tables entity_profiles and entity_profile_cursors", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    const names = tableNames(db);
    expect(names).toContain("entity_profiles");
    expect(names).toContain("entity_profile_cursors");

    const pcols = colNames(db, "entity_profiles");
    for (const c of [
      "entity_id",
      "profile_md",
      "source_fact_ids",
      "embedding",
      "fact_count",
      "version",
      "model",
      "built_at",
      "updated_at",
    ]) {
      expect(pcols).toContain(c);
    }
    closeDb();
  });

  it("creates the entity_exclusions table", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    expect(tableNames(db)).toContain("entity_exclusions");
    const cols = colNames(db, "entity_exclusions");
    for (const c of ["entity_id", "reason", "created_at", "created_by"]) {
      expect(cols).toContain(c);
    }
    closeDb();
  });

  it("adds subject_entity_id and scope_team_id governance columns to memories", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    const cols = colNames(db, "memories");
    expect(cols).toContain("subject_entity_id");
    expect(cols).toContain("scope_team_id");
    // existing memory columns must remain intact
    expect(cols).toContain("content_hash");
    expect(cols).toContain("visibility");
    closeDb();
  });

  it("enforces a partial-unique slack_user_id only among active entities", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    const insert = db.prepare(
      `INSERT INTO entities (type, canonical_name, normalized_name, slack_user_id, status, confidence, created_at, updated_at)
       VALUES ('person', ?, ?, ?, ?, 0.9, '2026-06-14T00:00:00.000Z', '2026-06-14T00:00:00.000Z')`
    );

    insert.run("Rahul Sharma", "rahul sharma", "U1", "active");
    // A second ACTIVE row with the same slack_user_id must be rejected.
    expect(() => insert.run("Rahul S", "rahul s", "U1", "active")).toThrow();
    // A merged tombstone may retain the same slack_user_id (partial index).
    expect(() => insert.run("Rahul Old", "rahul old", "U1", "merged")).not.toThrow();
    closeDb();
  });

  it("enforces a partial-unique email only among active entities", async () => {
    const { getDb, closeDb } = await loadFreshDb();
    const db = getDb();

    const insert = db.prepare(
      `INSERT INTO entities (type, canonical_name, normalized_name, email, status, confidence, created_at, updated_at)
       VALUES ('person', ?, ?, ?, ?, 0.9, '2026-06-14T00:00:00.000Z', '2026-06-14T00:00:00.000Z')`
    );
    insert.run("A", "a", "a@newtonschool.co", "active");
    expect(() => insert.run("B", "b", "a@newtonschool.co", "active")).toThrow();
    closeDb();
  });

  it("re-running migrations does not error and preserves the entity tables", async () => {
    const first = await loadFreshDb();
    first.getDb();
    first.closeDb();

    vi.resetModules();
    vi.doMock("pino", () => {
      const noop = () => {};
      const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
      const pino = () => logger;
      pino.stdTimeFunctions = { isoTime: () => "" };
      return { default: pino };
    });
    const second = await loadFreshDb();
    expect(() => second.getDb()).not.toThrow();
    expect(tableNames(second.getDb())).toContain("entities");
    second.closeDb();
  });

  it("guarded governance-column ALTER is idempotent across a real reopen (file-backed)", async () => {
    const dbPath = join(
      tmpdir(),
      `sentinel-migrate-${process.pid}-${Math.floor(performance.now())}.db`
    );
    const loadAt = async (path: string) => {
      vi.resetModules();
      vi.doMock("pino", () => {
        const noop = () => {};
        const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
        const pino = () => logger;
        pino.stdTimeFunctions = { isoTime: () => "" };
        return { default: pino };
      });
      vi.doMock("../src/config.js", () => ({
        config: { SQLITE_DB_PATH: path, LOG_LEVEL: "silent" },
      }));
      return import("../src/state/db.js");
    };

    try {
      const a = await loadAt(dbPath);
      a.getDb();
      a.closeDb();

      // Reopen the SAME file → migrations re-run against an existing
      // `memories` table, exercising the guarded ALTER TABLE ADD COLUMN path.
      const b = await loadAt(dbPath);
      expect(() => b.getDb()).not.toThrow();
      const cols = (
        b.getDb().pragma("table_info(memories)") as Array<{ name: string }>
      ).map((c) => c.name);
      expect(cols).toContain("subject_entity_id");
      expect(cols).toContain("scope_team_id");
      b.closeDb();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          rmSync(dbPath + suffix);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  });
});
