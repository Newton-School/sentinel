import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

beforeEach(async () => {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
});

afterEach(async () => {
  const { closeDb } = await import("../src/state/db.js");
  await closeDb();
});

/** Lowercased public-schema table names from information_schema. */
async function tableNames(): Promise<string[]> {
  const { getPool } = await import("../src/state/db.js");
  const r = await getPool().query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
  );
  return r.rows.map((t) => t.table_name);
}

/** Column names of a public-schema table from information_schema. */
async function colNames(table: string): Promise<string[]> {
  const { getPool } = await import("../src/state/db.js");
  const r = await getPool().query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return r.rows.map((c) => c.column_name);
}

/** Index names for a public-schema table from pg_indexes. */
async function indexNames(table: string): Promise<string[]> {
  const { getPool } = await import("../src/state/db.js");
  const r = await getPool().query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table]
  );
  return r.rows.map((i) => i.indexname);
}

describe("database migrations", () => {
  it("creates the core application tables", async () => {
    const names = await tableNames();
    for (const t of [
      "personas",
      "persona_traits",
      "query_log",
      "joined_meetings",
      "memories",
      "entities",
      "entity_edges",
      "llm_calls",
      "feedback",
      "eval_runs",
    ]) {
      expect(names).toContain(t);
    }
  });

  it("query_log carries the response-audit columns alongside the originals", async () => {
    const cols = await colNames("query_log");
    // audit columns
    expect(cols).toContain("response_text");
    expect(cols).toContain("response_duration_ms");
    expect(cols).toContain("sources_used");
    // original columns
    expect(cols).toContain("user_id");
    expect(cols).toContain("query_text");
    expect(cols).toContain("category");
    expect(cols).toContain("created_at");
  });

  it("creates user_id and created_at indexes on query_log", async () => {
    const idx = await indexNames("query_log");
    expect(idx).toContain("idx_query_log_user_id");
    expect(idx).toContain("idx_query_log_created_at");
  });

  it("creates the joined_meetings table with the expected columns", async () => {
    expect(await tableNames()).toContain("joined_meetings");
    const cols = await colNames("joined_meetings");
    expect(cols).toContain("event_id");
    expect(cols).toContain("joined_at");
  });

  it("re-running initDb() is idempotent and does not throw", async () => {
    // The schema was already built once in beforeEach. Force a fresh module
    // graph (drops the pool singleton) and re-run initDb against the same DB.
    vi.resetModules();
    vi.doMock("pino", () => {
      const noop = () => {};
      const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
      const pino = () => logger;
      pino.stdTimeFunctions = { isoTime: () => "" };
      return { default: pino };
    });
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb } = await import("../src/state/db.js");
    await expect(initDb()).resolves.toBeDefined();
    // The migration only re-runs (and could collide on duplicate columns) if the
    // process-wide SCHEMA_READY guard is bypassed; this exercises the
    // CREATE ... IF NOT EXISTS path safely either way.
    await expect(initDb()).resolves.toBeDefined();
    expect(await tableNames()).toContain("memories");
  });

  it("llm_calls enforces an openai-only provider CHECK", async () => {
    const { getPool } = await import("../src/state/db.js");
    const pool = getPool();

    // openai is accepted.
    await expect(
      pool.query(
        `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
         VALUES ('c-o', 't', 'openai', 'gpt-5.4-mini', 'reply', 'ok', '2026-06-02T00:00:00.000Z')`
      )
    ).resolves.toBeDefined();

    // The legacy 'anthropic' provider is rejected by the tightened CHECK.
    await expect(
      pool.query(
        `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
         VALUES ('c-a', 't', 'anthropic', 'claude', 'reply', 'ok', '2026-06-01T00:00:00.000Z')`
      )
    ).rejects.toThrow();

    // Only the openai row persisted.
    const rows = (await pool.query<{ provider: string }>(`SELECT provider FROM llm_calls`)).rows;
    expect(rows).toEqual([{ provider: "openai" }]);
  });

  it("recreates the expected indexes on llm_calls", async () => {
    const idx = await indexNames("llm_calls");
    expect(idx).toContain("idx_llm_calls_trace");
    expect(idx).toContain("idx_llm_calls_created_at");
    expect(idx).toContain("idx_llm_calls_op_model");
  });
});

describe("company brain — entity graph schema", () => {
  it("creates the entities table with identity, scoping and embedding columns", async () => {
    expect(await tableNames()).toContain("entities");
    const cols = await colNames("entities");
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
  });

  it("creates entity_edges with relation, confidence and evidence columns + indexes", async () => {
    expect(await tableNames()).toContain("entity_edges");
    const cols = await colNames("entity_edges");
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

    const idx = await indexNames("entity_edges");
    expect(idx).toContain("idx_edges_src");
    expect(idx).toContain("idx_edges_dst");
  });

  it("creates memory_entities join table keyed by (memory_id, entity_id, role)", async () => {
    expect(await tableNames()).toContain("memory_entities");
    const cols = await colNames("memory_entities");
    for (const c of ["memory_id", "entity_id", "role", "confidence", "created_at"]) {
      expect(cols).toContain(c);
    }
  });

  it("creates dossier tables entity_profiles and entity_profile_cursors", async () => {
    const names = await tableNames();
    expect(names).toContain("entity_profiles");
    expect(names).toContain("entity_profile_cursors");

    const pcols = await colNames("entity_profiles");
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
  });

  it("creates the entity_exclusions table", async () => {
    expect(await tableNames()).toContain("entity_exclusions");
    const cols = await colNames("entity_exclusions");
    for (const c of ["entity_id", "reason", "created_at", "created_by"]) {
      expect(cols).toContain(c);
    }
  });

  it("adds subject_entity_id and scope_team_id governance columns to memories", async () => {
    const cols = await colNames("memories");
    expect(cols).toContain("subject_entity_id");
    expect(cols).toContain("scope_team_id");
    // existing memory columns must remain intact
    expect(cols).toContain("content_hash");
    expect(cols).toContain("visibility");
  });

  it("memories has the generated fts tsvector column and a unique content_hash index", async () => {
    const { getPool } = await import("../src/state/db.js");
    const pool = getPool();

    // fts is a STORED generated tsvector column.
    const fts = (
      await pool.query<{ data_type: string; is_generated: string }>(
        `SELECT data_type, is_generated FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'memories' AND column_name = 'fts'`
      )
    ).rows[0];
    expect(fts).toBeDefined();
    expect(fts.data_type).toBe("tsvector");
    expect(fts.is_generated).toBe("ALWAYS");

    // content_hash is enforced unique (idx_memories_hash is a UNIQUE index).
    expect(await indexNames("memories")).toContain("idx_memories_hash");
    const now = "2026-06-14T00:00:00.000Z";
    const insert = (hash: string) =>
      pool.query(
        `INSERT INTO memories (text, source_type, content_hash, created_at, updated_at)
         VALUES ('a fact', 'manual', $1, $2, $2)`,
        [hash, now]
      );
    await expect(insert("dup-hash")).resolves.toBeDefined();
    await expect(insert("dup-hash")).rejects.toThrow();
  });

  it("enforces a partial-unique slack_user_id only among active entities", async () => {
    const { getPool } = await import("../src/state/db.js");
    const pool = getPool();
    const now = "2026-06-14T00:00:00.000Z";
    const insert = (canonical: string, normalized: string, uid: string, status: string) =>
      pool.query(
        `INSERT INTO entities (type, canonical_name, normalized_name, slack_user_id, status, confidence, created_at, updated_at)
         VALUES ('person', $1, $2, $3, $4, 0.9, $5, $5)`,
        [canonical, normalized, uid, status, now]
      );

    await insert("Rahul Sharma", "rahul sharma", "U1", "active");
    // A second ACTIVE row with the same slack_user_id must be rejected.
    await expect(insert("Rahul S", "rahul s", "U1", "active")).rejects.toThrow();
    // A merged tombstone may retain the same slack_user_id (partial index).
    await expect(insert("Rahul Old", "rahul old", "U1", "merged")).resolves.toBeDefined();
  });

  it("enforces a partial-unique email only among active entities", async () => {
    const { getPool } = await import("../src/state/db.js");
    const pool = getPool();
    const now = "2026-06-14T00:00:00.000Z";
    const insert = (canonical: string, normalized: string, email: string, status: string) =>
      pool.query(
        `INSERT INTO entities (type, canonical_name, normalized_name, email, status, confidence, created_at, updated_at)
         VALUES ('person', $1, $2, $3, $4, 0.9, $5, $5)`,
        [canonical, normalized, email, status, now]
      );
    await insert("A", "a", "a@newtonschool.co", "active");
    await expect(insert("B", "b", "a@newtonschool.co", "active")).rejects.toThrow();
  });

  it("re-running migrations preserves the entity tables", async () => {
    // Re-init on a fresh module graph; entities must survive.
    vi.resetModules();
    vi.doMock("pino", () => {
      const noop = () => {};
      const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
      const pino = () => logger;
      pino.stdTimeFunctions = { isoTime: () => "" };
      return { default: pino };
    });
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb } = await import("../src/state/db.js");
    await expect(initDb()).resolves.toBeDefined();
    expect(await tableNames()).toContain("entities");
  });
});
