import Database from "better-sqlite3";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  log.info({ path: config.SQLITE_DB_PATH }, "Opening SQLite database");
  _db = new Database(config.SQLITE_DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  runMigrations(_db);
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

  log.info("Migrations complete");
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
