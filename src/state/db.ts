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

/** Default retention window for llm_calls trace rows, in days. */
export const LLM_CALLS_RETENTION_DAYS = 90;

/** Default retention window for eval_runs rows, in days (kept long — eval
 * history is valuable for tracking quality trends across prompt versions). */
export const EVAL_RUNS_RETENTION_DAYS = 180;

/** Retention for feedback rows (kept long — quality signal worth trending). */
export const FEEDBACK_RETENTION_DAYS = 180;

/** Retention for bot_replies rows (only needed long enough to attribute a late
 * reaction; pruned sooner than feedback itself). */
export const BOT_REPLIES_RETENTION_DAYS = 90;

/**
 * True when the DB handle is already open. The LLM trace sink
 * (src/llm/traceStore.ts) consults this so it only writes a durable row when
 * the app has already initialized the DB — it must never auto-open a stray
 * database (which in tests would pollute ./sentinel.db).
 */
export function isDbOpen(): boolean {
  return _db !== null;
}

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
    try {
      const deleted = pruneLlmCalls();
      if (deleted > 0) {
        log.info({ deleted }, "Pruned stale llm_calls rows");
      }
    } catch (err) {
      log.error({ err }, "llm_calls retention prune failed (non-fatal)");
    }
    try {
      const deleted = pruneEvalRuns();
      if (deleted > 0) {
        log.info({ deleted }, "Pruned stale eval_runs rows");
      }
    } catch (err) {
      log.error({ err }, "eval_runs retention prune failed (non-fatal)");
    }
    try {
      const fb = pruneFeedback();
      const br = pruneBotReplies();
      if (fb > 0 || br > 0) {
        log.info({ feedback: fb, botReplies: br }, "Pruned stale feedback rows");
      }
    } catch (err) {
      log.error({ err }, "feedback retention prune failed (non-fatal)");
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

  // Migration: company-brain entity graph. People/teams become first-class
  // entities; facts link to them via memory_entities; entity_edges holds the
  // (derived) org chart; entity_profiles holds rolling per-entity dossiers.
  // All additive CREATE ... IF NOT EXISTS, so re-runs are no-ops. `entities`
  // is created before the memories governance-column ALTER below so the
  // schema referencing it exists first.
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL CHECK (type IN
        ('person','team','project','metric','product','customer','vendor','other')),
      canonical_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      aliases TEXT,
      slack_user_id TEXT,
      email TEXT,
      metadata TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      visibility TEXT NOT NULL DEFAULT 'founders',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','forgotten')),
      merged_into INTEGER REFERENCES entities(id),
      embedding BLOB,
      source_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_type_status ON entities(type, status);
    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    -- Hard identity keys are unique only among ACTIVE rows: a merged tombstone
    -- keeps its old key for audit. Partial unique indexes are the primary
    -- entity-fragmentation guard.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slack_uid
      ON entities(slack_user_id) WHERE slack_user_id IS NOT NULL AND status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_email
      ON entities(email) WHERE email IS NOT NULL AND status = 'active';

    CREATE TABLE IF NOT EXISTS entity_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src_id INTEGER NOT NULL REFERENCES entities(id),
      dst_id INTEGER NOT NULL REFERENCES entities(id),
      relation TEXT NOT NULL CHECK (relation IN
        ('member_of','manages','reports_to','owns','works_on','depends_on','part_of','related_to')),
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      provenance TEXT,
      asserted_at TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','forgotten')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(src_id, dst_id, relation)
    );

    CREATE INDEX IF NOT EXISTS idx_edges_src ON entity_edges(src_id, relation, status);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON entity_edges(dst_id, relation, status);

    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id INTEGER NOT NULL REFERENCES memories(id),
      entity_id INTEGER NOT NULL REFERENCES entities(id),
      role TEXT NOT NULL DEFAULT 'mention' CHECK (role IN ('subject','owner','mention','about')),
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, entity_id, role)
    );

    CREATE INDEX IF NOT EXISTS idx_mement_entity ON memory_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_mement_memory ON memory_entities(memory_id);

    CREATE TABLE IF NOT EXISTS entity_profiles (
      entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
      profile_md TEXT NOT NULL,
      source_fact_ids TEXT NOT NULL,
      embedding BLOB,
      fact_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      model TEXT NOT NULL DEFAULT 'haiku',
      built_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_profile_cursors (
      entity_id INTEGER PRIMARY KEY,
      last_fact_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entity_exclusions (
      entity_id INTEGER PRIMARY KEY REFERENCES entities(id),
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: per-fact governance columns on memories. `subject_entity_id` is
  // the single person/team a fact is ABOUT (ACL keys on this, not every
  // mention); `scope_team_id` is an explicit team scope for team-visibility
  // rows. Plain INTEGER (no inline FK): ALTER TABLE ADD COLUMN with a
  // REFERENCES clause is brittle under FK enforcement, and write integrity is
  // guaranteed in code by the entity resolver. Guarded so re-runs are no-ops.
  const memColumns = db.pragma("table_info(memories)") as Array<{ name: string }>;
  const memColNames = new Set(memColumns.map((c) => c.name));
  if (!memColNames.has("subject_entity_id")) {
    db.exec(`ALTER TABLE memories ADD COLUMN subject_entity_id INTEGER`);
    log.info("Added subject_entity_id column to memories");
  }
  if (!memColNames.has("scope_team_id")) {
    db.exec(`ALTER TABLE memories ADD COLUMN scope_team_id INTEGER`);
    log.info("Added scope_team_id column to memories");
  }

  // Migration: LLMOps trace sink. One row per LLM call (Claude reply +
  // OpenAI extract/consolidate/embed/summary), correlated by trace_id across a
  // request's fan-out. Token/cost/latency are nullable (telemetry can be
  // absent; no-key/budget skips are not recorded here). created_at is an ISO
  // string so it reuses the lexicographic-cutoff prune pattern.
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('anthropic','openai')),
      model TEXT NOT NULL,
      operation TEXT NOT NULL CHECK (operation IN ('reply','extract','consolidate','embed','summary')),
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL,
      latency_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
      error_kind TEXT,
      num_turns INTEGER,
      user_id TEXT,
      prompt_version TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_llm_calls_trace ON llm_calls(trace_id);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_op_model ON llm_calls(operation, model);
  `);

  // Migration: prompt_version stamp (added after llm_calls shipped in #98).
  // Guarded ALTER for DBs whose table predates this column; fresh DBs already
  // have it from the CREATE above.
  const llmColumns = db.pragma("table_info(llm_calls)") as Array<{ name: string }>;
  if (!new Set(llmColumns.map((c) => c.name)).has("prompt_version")) {
    db.exec(`ALTER TABLE llm_calls ADD COLUMN prompt_version TEXT`);
    log.info("Added prompt_version column to llm_calls");
  }

  // Migration: offline eval-harness run history. One row per suite per run; the
  // dashboard reads the latest per suite for the eval pass-rate gauge.
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      suite TEXT NOT NULL,
      n_cases INTEGER NOT NULL,
      n_pass INTEGER NOT NULL,
      mean_score REAL NOT NULL,
      prompt_version TEXT,
      judge_version TEXT,
      ran_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_eval_runs_ran_at ON eval_runs(ran_at);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite, ran_at);
  `);

  // Migration: feedback loop. bot_replies maps a posted reply (channel+ts) to
  // the request trace id (and keeps the Q&A text so 👎'd replies can be
  // harvested into eval datasets); feedback records the 👍/👎 reactions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_replies (
      channel_id TEXT NOT NULL,
      reply_ts TEXT NOT NULL,
      trace_id TEXT,
      user_id TEXT,
      question TEXT,
      answer TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (channel_id, reply_ts)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      channel_id TEXT NOT NULL,
      reply_ts TEXT NOT NULL,
      reactor_user_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      sentiment TEXT NOT NULL CHECK (sentiment IN ('positive','negative')),
      score INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(channel_id, reply_ts, reactor_user_id, reaction)
    );

    CREATE INDEX IF NOT EXISTS idx_feedback_trace ON feedback(trace_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
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

/**
 * Deletes llm_calls rows older than the retention window. `created_at` is an
 * ISO 8601 string, so the cutoff is compared lexicographically (valid for
 * fixed-format UTC ISO timestamps). Rows strictly older than the cutoff are
 * removed; a row exactly at the boundary is kept.
 *
 * @param retentionDays how many days of trace history to keep (default 90)
 * @param nowMs reference "now" in epoch ms (defaults to Date.now()); injectable for tests
 * @returns the number of rows deleted
 */
export function pruneLlmCalls(
  retentionDays = LLM_CALLS_RETENTION_DAYS,
  nowMs?: number
): number {
  const db = getDb();
  const now = nowMs ?? Date.now();
  const cutoffIso = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(`DELETE FROM llm_calls WHERE created_at < ?`).run(cutoffIso);
  return result.changes;
}

/**
 * Deletes eval_runs rows older than the retention window. `ran_at` is an ISO
 * string compared lexicographically; rows strictly older than the cutoff are
 * removed.
 *
 * @param retentionDays days of eval history to keep (default 180)
 * @param nowMs reference "now" in epoch ms (defaults to Date.now()); injectable for tests
 * @returns the number of rows deleted
 */
export function pruneEvalRuns(
  retentionDays = EVAL_RUNS_RETENTION_DAYS,
  nowMs?: number
): number {
  const db = getDb();
  const now = nowMs ?? Date.now();
  const cutoffIso = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`DELETE FROM eval_runs WHERE ran_at < ?`).run(cutoffIso).changes;
}

/** Deletes feedback rows older than the retention window. */
export function pruneFeedback(retentionDays = FEEDBACK_RETENTION_DAYS, nowMs?: number): number {
  const db = getDb();
  const cutoffIso = new Date((nowMs ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`DELETE FROM feedback WHERE created_at < ?`).run(cutoffIso).changes;
}

/** Deletes bot_replies rows older than the retention window. */
export function pruneBotReplies(retentionDays = BOT_REPLIES_RETENTION_DAYS, nowMs?: number): number {
  const db = getDb();
  const cutoffIso = new Date((nowMs ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare(`DELETE FROM bot_replies WHERE created_at < ?`).run(cutoffIso).changes;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
    log.info("Database closed");
  }
}
