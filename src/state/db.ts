import Database from "better-sqlite3";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("db");

let _db: Database.Database | null = null;
let _prunedThisProcess = false;
let _ftsAvailable = false;

/** Default retention window for query_log rows, in days. */
export const QUERY_LOG_RETENTION_DAYS = 90;

/** Default retention window for non-active memory rows, in days. */
export const MEMORY_RETENTION_DAYS = 90;

/**
 * True when the FTS5 virtual table + triggers were created successfully
 * during migration. False on SQLite builds without the fts5 module — memory
 * search then degrades to a LIKE scan (see src/memory/memorySql.ts).
 */
export function isFtsAvailable(): boolean {
  return _ftsAvailable;
}

export function getDb(): Database.Database {
  if (_db) return _db;

  log.info({ path: config.SQLITE_DB_PATH }, "Opening SQLite database");
  _db = new Database(config.SQLITE_DB_PATH);
  _db.pragma("journal_mode = WAL");
  // Wait up to 5s on a locked database instead of throwing SQLITE_BUSY
  // immediately — the Meet joiner runs as a separate process against the same
  // file, and WAL still allows brief lock contention on checkpoints.
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");

  runMigrations(_db);

  // Enforce retention once per process. Must never break getDb():
  // a prune failure is logged and swallowed.
  if (!_prunedThisProcess) {
    _prunedThisProcess = true;
    try {
      const deleted = pruneQueryLog();
      if (deleted > 0) {
        log.info({ deleted }, "Pruned stale query_log rows");
      }
    } catch (err) {
      log.error({ err }, "query_log retention prune failed (non-fatal)");
    }
    try {
      const deleted = pruneMemories();
      if (deleted > 0) {
        log.info({ deleted }, "Pruned stale non-active memory rows");
      }
    } catch (err) {
      log.error({ err }, "memories retention prune failed (non-fatal)");
    }
  }

  return _db;
}

function runMigrations(db: Database.Database): void {
  log.info("Running database migrations");

  // Initial schema
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      query_text TEXT NOT NULL,
      category TEXT,
      created_at TEXT NOT NULL
    );

    -- Persists Meet-watcher join dedup so it survives process restarts:
    -- joined_at is epoch ms; rows older than the watcher's TTL are purged.
    CREATE TABLE IF NOT EXISTS joined_meetings (
      event_id TEXT PRIMARY KEY,
      joined_at INTEGER NOT NULL
    );
  `);

  // Migration: add response audit columns to query_log
  const columns = db.pragma("table_info(query_log)") as Array<{ name: string }>;
  const columnNames = new Set(columns.map((c) => c.name));

  if (!columnNames.has("response_text")) {
    db.exec(`ALTER TABLE query_log ADD COLUMN response_text TEXT`);
    log.info("Added response_text column to query_log");
  }

  if (!columnNames.has("response_duration_ms")) {
    db.exec(`ALTER TABLE query_log ADD COLUMN response_duration_ms INTEGER`);
    log.info("Added response_duration_ms column to query_log");
  }

  if (!columnNames.has("sources_used")) {
    db.exec(`ALTER TABLE query_log ADD COLUMN sources_used TEXT`);
    log.info("Added sources_used column to query_log");
  }

  // Migration: indexes on query_log (idempotent).
  // user_id supports per-user lookups; created_at supports time-based retention pruning.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_query_log_user_id ON query_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log(created_at);
  `);

  // Migration: persistent organizational memory (facts extracted from
  // conversations/meetings/emails), plus ingestion bookkeeping tables.
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'fact'
        CHECK (category IN ('decision','fact','owner','deadline','metric','preference','summary')),
      entities TEXT,
      source_type TEXT NOT NULL CHECK (source_type IN ('conversation','meeting','email','manual')),
      source_ref TEXT,
      source_label TEXT,
      speaker TEXT,
      asserted_at TEXT,
      evidence_quote TEXT,
      confidence REAL NOT NULL DEFAULT 0.7,
      verified INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'founders',
      sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive')),
      derived_from_memory INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','forgotten')),
      superseded_by INTEGER REFERENCES memories(id),
      embedding BLOB,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
    CREATE INDEX IF NOT EXISTS idx_memories_status_created ON memories(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_type, source_ref);

    CREATE TABLE IF NOT EXISTS ingest_cursors (
      source TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingested_docs (
      doc_id TEXT PRIMARY KEY,
      ingested_at INTEGER NOT NULL
    );
  `);

  // FTS5 external-content index over memories + sync triggers. Some SQLite
  // builds ship without the fts5 module, so this runs in its own try/catch:
  // on failure the flag stays false and memory search degrades to a LIKE
  // scan instead of breaking startup.
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, entities, source_label,
        content='memories', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text, entities, source_label)
        VALUES (new.id, new.text, new.entities, new.source_label);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, entities, source_label)
        VALUES('delete', old.id, old.text, old.entities, old.source_label);
      END;

      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, entities, source_label ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text, entities, source_label)
        VALUES('delete', old.id, old.text, old.entities, old.source_label);
        INSERT INTO memories_fts(rowid, text, entities, source_label)
        VALUES (new.id, new.text, new.entities, new.source_label);
      END;
    `);
    _ftsAvailable = true;
  } catch (err) {
    _ftsAvailable = false;
    log.warn(
      { err },
      "FTS5 unavailable — memory search will degrade to LIKE scans"
    );
  }

  log.info("Migrations complete");
}

/**
 * Deletes query_log rows older than the retention window.
 *
 * query_log.created_at is stored as an ISO 8601 string (see persona tracker),
 * so the cutoff is computed as an ISO string and compared lexicographically —
 * which is a valid chronological comparison for fixed-format UTC ISO timestamps.
 *
 * Rows with created_at strictly older than the cutoff are removed; a row
 * exactly at the boundary is kept.
 *
 * @param retentionDays how many days of history to keep (default 90)
 * @param nowMs reference "now" in epoch ms (defaults to Date.now()); injectable for tests
 * @returns the number of rows deleted
 */
export function pruneQueryLog(
  retentionDays = QUERY_LOG_RETENTION_DAYS,
  nowMs?: number
): number {
  const db = getDb();
  const now = nowMs ?? Date.now();
  const cutoffIso = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(`DELETE FROM query_log WHERE created_at < ?`)
    .run(cutoffIso);
  return result.changes;
}

/**
 * Deletes non-active memory rows (`status != 'active'`) whose `updated_at`
 * is older than the retention window. `updated_at` is bumped when a row is
 * forgotten/superseded, so this keeps tombstones for `retentionDays` after
 * retirement, then drops them.
 *
 * Runs with deferred foreign keys inside a transaction so superseded CHAINS
 * (old → older → oldest, linked via superseded_by) can be deleted in one
 * statement without tripping the self-referential FK mid-delete.
 *
 * @param retentionDays how many days to keep retired rows (default 90)
 * @param nowMs reference "now" in epoch ms (defaults to Date.now()); injectable for tests
 * @returns the number of rows deleted
 */
export function pruneMemories(
  retentionDays = MEMORY_RETENTION_DAYS,
  nowMs?: number
): number {
  const db = getDb();
  const now = nowMs ?? Date.now();
  const cutoffIso = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const prune = db.transaction((): number => {
    db.pragma("defer_foreign_keys = ON");
    return db
      .prepare(`DELETE FROM memories WHERE status != 'active' AND updated_at < ?`)
      .run(cutoffIso).changes;
  });
  return prune();
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
