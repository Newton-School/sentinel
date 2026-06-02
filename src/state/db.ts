import Database from "better-sqlite3";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("db");

let _db: Database.Database | null = null;
let _prunedThisProcess = false;

/** Default retention window for query_log rows, in days. */
export const QUERY_LOG_RETENTION_DAYS = 90;

export function getDb(): Database.Database {
  if (_db) return _db;

  log.info({ path: config.SQLITE_DB_PATH }, "Opening SQLite database");
  _db = new Database(config.SQLITE_DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  runMigrations(_db);

  // Enforce query_log retention once per process. Must never break getDb():
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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
