import pg from "pg";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const { Pool } = pg;
type Pool = pg.Pool;
type PoolClient = pg.PoolClient;

/**
 * Anything that can run a query: the shared pool or a transaction-bound client.
 * SQL helpers accept this as their first arg (replacing the better-sqlite3
 * `Database` handle) so the same code runs on the pool, inside `withTx`, and
 * from the per-request memory MCP subprocess against its own pool.
 */
export type Queryable = Pick<Pool, "query">;

/** The pg connection pool type (re-exported so callers needn't import `pg`). */
export type DbPool = Pool;

const log = createLogger("db");

// pg returns int8/numeric as strings by default to avoid precision loss. Our
// ids are `integer` (int4) so they already arrive as JS numbers; numeric/double
// columns (confidence, scores) we want as numbers too — int4 (23) is fine, but
// force float8 (701) and numeric (1700) to Number for the row mappers.
pg.types.setTypeParser(701, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));

let _pool: Pool | null = null;
let _initialized = false;
let _prunedThisProcess = false;
let _ftsAvailable = false;

// Process-wide (survives module resets) set of DATABASE_URLs whose schema has
// already been migrated this process — see initDb.
const SCHEMA_READY = Symbol.for("sentinel.db.schemaReady");

/** Default retention window for query_log rows, in days. */
export const QUERY_LOG_RETENTION_DAYS = 90;
/** Default retention window for non-active memory rows, in days. */
export const MEMORY_RETENTION_DAYS = 90;
/** Default retention window for llm_calls trace rows, in days. */
export const LLM_CALLS_RETENTION_DAYS = 90;
/** Default retention window for eval_runs rows, in days. */
export const EVAL_RUNS_RETENTION_DAYS = 180;
/** Retention for feedback rows, in days. */
export const FEEDBACK_RETENTION_DAYS = 180;
/** Retention for bot_replies rows, in days. */
export const BOT_REPLIES_RETENTION_DAYS = 90;

/**
 * True once the pool is open AND the schema has been initialized. The LLM trace
 * sink (src/llm/traceStore.ts) consults this so it only writes a durable row
 * when the app has already initialized the DB — it never auto-opens a pool.
 */
export function isDbOpen(): boolean {
  return _pool !== null && _initialized;
}

/**
 * True when the pg_search BM25 index over `memories` is available (ParadeDB).
 * False on a vanilla-Postgres build without pg_search — memory search then
 * degrades to a trigram/ILIKE scan (see src/memory/memorySql.ts). Set during
 * initSchema (A3).
 */
export function isFtsAvailable(): boolean {
  return _ftsAvailable;
}

/** The connection pool. Throws if {@link initDb} hasn't run yet. */
export function getPool(): Pool {
  if (!_pool) throw new Error("Database not initialized — call initDb() first");
  return _pool;
}

/**
 * Open the pool, run idempotent migrations, and enforce retention once per
 * process. Idempotent: safe to call multiple times (subsequent calls are
 * no-ops). Replaces the lazy getDb() of the SQLite era — Postgres queries are
 * async, so the app awaits this once at boot (src/index.ts) before serving.
 */
export async function initDb(): Promise<Pool> {
  if (_pool && _initialized) return _pool;

  if (!_pool) {
    log.info({ db: redactUrl(config.DATABASE_URL) }, "Opening Postgres pool");
    _pool = new Pool({
      connectionString: config.DATABASE_URL,
      max: config.PG_POOL_MAX,
      // Fail fast rather than hang if Postgres is unreachable.
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    // A pool 'error' on an idle client must never crash the process.
    _pool.on("error", (err) => log.error({ err }, "idle pg client error (non-fatal)"));
  }

  // Schema migration is idempotent but not free (extension probes + ~17
  // CREATE-IF-NOT-EXISTS). Skip it when this process already built the schema
  // for this URL — keyed on globalThis so it survives test module resets
  // (vitest resetModules drops the pool singleton, so initDb re-runs per test).
  const url = config.DATABASE_URL ?? "";
  const ready: Set<string> = ((globalThis as Record<symbol, unknown>)[SCHEMA_READY] ??=
    new Set<string>()) as Set<string>;
  if (!ready.has(url)) {
    await runMigrations(_pool);
    ready.add(url);
  }
  _initialized = true;

  if (!_prunedThisProcess) {
    _prunedThisProcess = true;
    await runPrune("query_log", pruneQueryLog);
    await runPrune("memories", pruneMemories);
    await runPrune("llm_calls", pruneLlmCalls);
    await runPrune("eval_runs", pruneEvalRuns);
    await runPrune("feedback", pruneFeedback);
    await runPrune("bot_replies", pruneBotReplies);
  }

  return _pool;
}

async function runPrune(label: string, fn: () => Promise<number>): Promise<void> {
  try {
    const deleted = await fn();
    if (deleted > 0) log.info({ deleted, table: label }, "Pruned stale rows");
  } catch (err) {
    log.error({ err, table: label }, "retention prune failed (non-fatal)");
  }
}

function redactUrl(url?: string): string {
  if (!url) return "(unset)";
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(set)";
  }
}

async function runMigrations(pool: Pool): Promise<void> {
  log.info("Running database migrations");

  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS personas (
      user_id      text PRIMARY KEY,
      display_name text NOT NULL,
      role         text,
      created_at   text NOT NULL,
      updated_at   text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS persona_traits (
      id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id        text NOT NULL,
      label          text NOT NULL,
      value          text NOT NULL,
      confidence     double precision NOT NULL DEFAULT 0.5,
      evidence_count integer NOT NULL DEFAULT 1,
      created_at     text NOT NULL,
      updated_at     text NOT NULL,
      UNIQUE (user_id, label, value)
    );

    CREATE TABLE IF NOT EXISTS query_log (
      id                   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id              text NOT NULL,
      channel_id           text NOT NULL,
      thread_ts            text NOT NULL,
      query_text           text NOT NULL,
      category             text,
      created_at           text NOT NULL,
      response_text        text,
      response_duration_ms integer,
      sources_used         text
    );
    CREATE INDEX IF NOT EXISTS idx_query_log_user_id ON query_log(user_id);
    CREATE INDEX IF NOT EXISTS idx_query_log_created_at ON query_log(created_at);

    CREATE TABLE IF NOT EXISTS joined_meetings (
      event_id  text PRIMARY KEY,
      joined_at bigint NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      type            text NOT NULL CHECK (type IN
        ('person','team','project','metric','product','customer','vendor','other')),
      canonical_name  text NOT NULL,
      normalized_name text NOT NULL,
      aliases         text,
      slack_user_id   text,
      email           text,
      metadata        text,
      confidence      double precision NOT NULL DEFAULT 0.5,
      visibility      text NOT NULL DEFAULT 'founders',
      status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','forgotten')),
      merged_into     integer REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      embedding       vector(1536),
      source_ref      text,
      created_at      text NOT NULL,
      updated_at      text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_type_status ON entities(type, status);
    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_slack_uid
      ON entities(slack_user_id) WHERE slack_user_id IS NOT NULL AND status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_email
      ON entities(email) WHERE email IS NOT NULL AND status = 'active';

    CREATE TABLE IF NOT EXISTS memories (
      id                  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      text                text NOT NULL,
      category            text NOT NULL DEFAULT 'fact'
        CHECK (category IN ('decision','fact','owner','deadline','metric','preference','summary')),
      entities            text,
      source_type         text NOT NULL CHECK (source_type IN ('conversation','meeting','email','manual')),
      source_ref          text,
      source_label        text,
      speaker             text,
      asserted_at         text,
      evidence_quote      text,
      confidence          double precision NOT NULL DEFAULT 0.7,
      verified            integer NOT NULL DEFAULT 0,
      visibility          text NOT NULL DEFAULT 'founders',
      sensitivity         text NOT NULL DEFAULT 'normal' CHECK (sensitivity IN ('normal','sensitive')),
      derived_from_memory integer NOT NULL DEFAULT 0,
      content_hash        text NOT NULL,
      status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','forgotten')),
      superseded_by       integer REFERENCES memories(id) DEFERRABLE INITIALLY DEFERRED,
      embedding           vector(1536),
      subject_entity_id   integer,
      scope_team_id       integer,
      created_at          text NOT NULL,
      updated_at          text NOT NULL,
      -- Portable Postgres full-text vector over the searchable columns. Used by
      -- the lexical recall path (ts_rank) on any Postgres; ParadeDB adds a true
      -- BM25 index below. The 2-arg to_tsvector form is IMMUTABLE (generated-OK).
      fts tsvector GENERATED ALWAYS AS (
        to_tsvector('english',
          coalesce(text, '') || ' ' || coalesce(entities, '') || ' ' || coalesce(source_label, ''))
      ) STORED
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(content_hash);
    CREATE INDEX IF NOT EXISTS idx_memories_status_created ON memories(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_type, source_ref);
    CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories USING gin(fts);

    CREATE TABLE IF NOT EXISTS ingest_cursors (
      source     text PRIMARY KEY,
      cursor     text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ingested_docs (
      doc_id      text PRIMARY KEY,
      ingested_at bigint NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_edges (
      id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      src_id         integer NOT NULL REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      dst_id         integer NOT NULL REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      relation       text NOT NULL CHECK (relation IN
        ('member_of','manages','reports_to','owns','works_on','depends_on','part_of','related_to')),
      confidence     double precision NOT NULL DEFAULT 0.5,
      evidence_count integer NOT NULL DEFAULT 1,
      provenance     text,
      asserted_at    text,
      status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','forgotten')),
      created_at     text NOT NULL,
      updated_at     text NOT NULL,
      UNIQUE (src_id, dst_id, relation)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src ON entity_edges(src_id, relation, status);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON entity_edges(dst_id, relation, status);

    CREATE TABLE IF NOT EXISTS memory_entities (
      memory_id  integer NOT NULL REFERENCES memories(id) DEFERRABLE INITIALLY DEFERRED,
      entity_id  integer NOT NULL REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      role       text NOT NULL DEFAULT 'mention' CHECK (role IN ('subject','owner','mention','about')),
      confidence double precision NOT NULL DEFAULT 0.5,
      created_at text NOT NULL,
      PRIMARY KEY (memory_id, entity_id, role)
    );
    CREATE INDEX IF NOT EXISTS idx_mement_entity ON memory_entities(entity_id);
    CREATE INDEX IF NOT EXISTS idx_mement_memory ON memory_entities(memory_id);

    CREATE TABLE IF NOT EXISTS entity_profiles (
      entity_id       integer PRIMARY KEY REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      profile_md      text NOT NULL,
      source_fact_ids text NOT NULL,
      embedding       vector(1536),
      fact_count      integer NOT NULL DEFAULT 0,
      version         integer NOT NULL DEFAULT 1,
      model           text NOT NULL DEFAULT 'gpt-4o',
      built_at        text NOT NULL,
      updated_at      text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entity_profile_cursors (
      entity_id       integer PRIMARY KEY,
      last_fact_count integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS entity_exclusions (
      entity_id  integer PRIMARY KEY REFERENCES entities(id) DEFERRABLE INITIALLY DEFERRED,
      reason     text,
      created_by text,
      created_at text NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id            integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id       text NOT NULL,
      trace_id      text NOT NULL,
      provider      text NOT NULL CHECK (provider = 'openai'),
      model         text NOT NULL,
      operation     text NOT NULL CHECK (operation IN ('reply','extract','consolidate','embed','summary')),
      input_tokens  integer,
      output_tokens integer,
      cost_usd      double precision,
      latency_ms    integer,
      status        text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error')),
      error_kind    text,
      num_turns     integer,
      user_id       text,
      prompt_version text,
      created_at    text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_calls_trace ON llm_calls(trace_id);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_created_at ON llm_calls(created_at);
    CREATE INDEX IF NOT EXISTS idx_llm_calls_op_model ON llm_calls(operation, model);

    CREATE TABLE IF NOT EXISTS eval_runs (
      id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      run_id         text NOT NULL,
      suite          text NOT NULL,
      n_cases        integer NOT NULL,
      n_pass         integer NOT NULL,
      mean_score     double precision NOT NULL,
      prompt_version text,
      judge_version  text,
      ran_at         text NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_runs_ran_at ON eval_runs(ran_at);
    CREATE INDEX IF NOT EXISTS idx_eval_runs_suite ON eval_runs(suite, ran_at);

    CREATE TABLE IF NOT EXISTS bot_replies (
      channel_id text NOT NULL,
      reply_ts   text NOT NULL,
      trace_id   text,
      user_id    text,
      question   text,
      answer     text,
      created_at text NOT NULL,
      PRIMARY KEY (channel_id, reply_ts)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      trace_id        text,
      channel_id      text NOT NULL,
      reply_ts        text NOT NULL,
      reactor_user_id text NOT NULL,
      reaction        text NOT NULL,
      sentiment       text NOT NULL CHECK (sentiment IN ('positive','negative')),
      score           integer NOT NULL,
      created_at      text NOT NULL,
      UNIQUE (channel_id, reply_ts, reactor_user_id, reaction)
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_trace ON feedback(trace_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
  `);

  // pg_search BM25 index over memories (ParadeDB). Optional: vanilla Postgres
  // lacks pg_search, so guard it — memory search falls back to trigram/ILIKE
  // when unavailable. The actual BM25 query path lands in A3.
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pg_search");
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_memories_bm25 ON memories
      USING bm25 (id, text, entities, source_label)
      WITH (key_field = 'id')
    `);
    _ftsAvailable = true;
    log.info("pg_search BM25 index ready");
  } catch (err) {
    _ftsAvailable = false;
    log.warn({ err: (err as Error).message }, "pg_search unavailable — memory search will use ILIKE/trigram fallback");
  }

  log.info("Migrations complete");
}

/**
 * Runs `fn(client)` inside a transaction on an explicit pool, with deferred FK
 * checks available. Used by SQL helpers that must be atomic regardless of which
 * pool owns them (the main-app singleton or the per-request memory MCP pool).
 */
export async function withTxOn<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** {@link withTxOn} bound to the main-app singleton pool. */
export function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTxOn(getPool(), fn);
}

/** Deletes query_log rows older than the retention window (lexicographic ISO cutoff). */
export async function pruneQueryLog(retentionDays = QUERY_LOG_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const cutoff = isoCutoff(retentionDays, nowMs);
  const r = await getPool().query(`DELETE FROM query_log WHERE created_at < $1`, [cutoff]);
  return r.rowCount ?? 0;
}

/** Deletes non-active memory rows older than retention; deferred FKs let
 * superseded chains delete in one statement without tripping the self FK. */
export async function pruneMemories(retentionDays = MEMORY_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const cutoff = isoCutoff(retentionDays, nowMs);
  return withTx(async (c) => {
    await c.query("SET CONSTRAINTS ALL DEFERRED");
    const r = await c.query(`DELETE FROM memories WHERE status <> 'active' AND updated_at < $1`, [cutoff]);
    return r.rowCount ?? 0;
  });
}

/** Deletes llm_calls rows older than the retention window. */
export async function pruneLlmCalls(retentionDays = LLM_CALLS_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const r = await getPool().query(`DELETE FROM llm_calls WHERE created_at < $1`, [isoCutoff(retentionDays, nowMs)]);
  return r.rowCount ?? 0;
}

/** Deletes eval_runs rows older than the retention window. */
export async function pruneEvalRuns(retentionDays = EVAL_RUNS_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const r = await getPool().query(`DELETE FROM eval_runs WHERE ran_at < $1`, [isoCutoff(retentionDays, nowMs)]);
  return r.rowCount ?? 0;
}

/** Deletes feedback rows older than the retention window. */
export async function pruneFeedback(retentionDays = FEEDBACK_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const r = await getPool().query(`DELETE FROM feedback WHERE created_at < $1`, [isoCutoff(retentionDays, nowMs)]);
  return r.rowCount ?? 0;
}

/** Deletes bot_replies rows older than the retention window. */
export async function pruneBotReplies(retentionDays = BOT_REPLIES_RETENTION_DAYS, nowMs?: number): Promise<number> {
  const r = await getPool().query(`DELETE FROM bot_replies WHERE created_at < $1`, [isoCutoff(retentionDays, nowMs)]);
  return r.rowCount ?? 0;
}

function isoCutoff(retentionDays: number, nowMs?: number): string {
  return new Date((nowMs ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
    _initialized = false;
    log.info("Database pool closed");
  }
}
