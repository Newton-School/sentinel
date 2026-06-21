import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as personaStore.test.ts / dbMigration.test.ts)
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

type DbModule = typeof import("../src/state/db.js");
type SqlModule = typeof import("../src/memory/memorySql.js");
type Pool = import("../src/state/db.js").DbPool;

async function load(): Promise<{ dbMod: DbModule; sql: SqlModule; pool: Pool }> {
  const dbMod = await import("../src/state/db.js");
  await dbMod.initDb();
  const sql = await import("../src/memory/memorySql.js");
  return { dbMod, sql, pool: dbMod.getPool() };
}

describe("memory store (schema + memorySql)", () => {
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

  describe("migration", () => {
    it("creates the memories, ingest_cursors and ingested_docs tables", async () => {
      const { pool } = await load();

      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
      );
      const names = rows.map((t) => t.tablename);
      expect(names).toContain("memories");
      expect(names).toContain("ingest_cursors");
      expect(names).toContain("ingested_docs");

      const cols = (
        await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'memories'`
        )
      ).rows.map((c) => c.column_name);
      for (const col of [
        "id", "text", "category", "entities", "source_type", "source_ref",
        "source_label", "speaker", "asserted_at", "evidence_quote", "confidence",
        "verified", "visibility", "sensitivity", "derived_from_memory",
        "content_hash", "status", "superseded_by", "embedding",
        "created_at", "updated_at",
      ]) {
        expect(cols).toContain(col);
      }
    });

    it("creates the memories indexes (unique hash, status_created, source)", async () => {
      const { pool } = await load();
      const indexes = (
        await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'memories'`
        )
      ).rows.map((i) => i.indexname);
      expect(indexes).toContain("idx_memories_hash");
      expect(indexes).toContain("idx_memories_status_created");
      expect(indexes).toContain("idx_memories_source");

      // idx_memories_hash is the UNIQUE index over content_hash.
      const { rows: hashIdx } = await pool.query<{ indisunique: boolean }>(
        `SELECT i.indisunique
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         WHERE c.relname = 'idx_memories_hash'`
      );
      expect(hashIdx[0]?.indisunique).toBe(true);
    });

    it("reports isFtsAvailable() (pg_search BM25 present or absent without throwing)", async () => {
      const { dbMod } = await load();
      // pg_search is optional (ParadeDB). Either way migration must have run and
      // isFtsAvailable() must return a boolean without throwing.
      expect(typeof dbMod.isFtsAvailable()).toBe("boolean");
    });

    it("is idempotent — re-running migrations on the same schema does not throw", async () => {
      const first = await import("../src/state/db.js");
      await first.initDb();
      expect(first.getPool()).toBeDefined();
      // initDb is idempotent: a second call is a no-op and must not throw.
      await expect(first.initDb()).resolves.toBeDefined();
    });
  });

  describe("insertFact", () => {
    it("inserts a fact with defaults and returns { deduped: false, id }", async () => {
      const { sql, pool } = await load();

      const result = await sql.insertFact(pool, {
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "meeting",
        sourceLabel: "Growth review",
      });

      expect(result.deduped).toBe(false);
      expect(result.id).toBeGreaterThan(0);

      const row = (
        await pool.query(`SELECT * FROM memories WHERE id = $1`, [result.id])
      ).rows[0] as Record<string, unknown>;
      expect(row.text).toBe("Q3 placement target is 250 offers");
      expect(row.category).toBe("decision");
      expect(row.source_type).toBe("meeting");
      expect(row.confidence).toBe(0.7);
      expect(row.status).toBe("active");
      expect(row.visibility).toBe("founders");
      expect(row.sensitivity).toBe("normal");
      expect(row.verified).toBe(0);
      expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("truncates text longer than 300 chars to 300", async () => {
      const { sql, pool } = await load();
      const long = "placements update ".repeat(30); // 540 chars
      const result = await sql.insertFact(pool, {
        text: long,
        category: "fact",
        sourceType: "conversation",
      });
      const row = (
        await pool.query(`SELECT text FROM memories WHERE id = $1`, [result.id])
      ).rows[0] as { text: string };
      expect(row.text.length).toBe(300);
      expect(row.text).toBe(long.slice(0, 300));
    });

    it("rejects empty / whitespace-only text", async () => {
      const { sql, pool } = await load();
      await expect(
        sql.insertFact(pool, { text: "   ", category: "fact", sourceType: "manual" })
      ).rejects.toThrow();
    });

    it("dedups on normalized content hash (case/punctuation-insensitive) and refreshes confidence + updated_at", async () => {
      const { sql, pool } = await load();
      const t1 = new Date("2026-06-01T00:00:00.000Z");
      const t2 = new Date("2026-06-05T00:00:00.000Z");

      const first = await sql.insertFact(pool, {
        text: "Q3 attrition target is 5%",
        category: "metric",
        sourceType: "meeting",
        confidence: 0.6,
        now: t1,
      });
      const second = await sql.insertFact(pool, {
        text: "q3, ATTRITION target -- is 5",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.9,
        now: t2,
      });

      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = (await pool.query(`SELECT * FROM memories`)).rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.9);
      expect(rows[0].updated_at).toBe(t2.toISOString());
    });

    it("dedup keeps the higher confidence when the re-assertion is weaker", async () => {
      const { sql, pool } = await load();
      const first = await sql.insertFact(pool, {
        text: "May revenue closed at 9.4 crore",
        category: "metric",
        sourceType: "email",
        confidence: 0.9,
      });
      const second = await sql.insertFact(pool, {
        text: "may revenue closed at 9 4 crore",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.5,
      });
      expect(second.deduped).toBe(true);
      const row = (
        await pool.query(`SELECT confidence FROM memories WHERE id = $1`, [first.id])
      ).rows[0] as { confidence: number };
      expect(row.confidence).toBe(0.9);
    });

    it("near-duplicate (Jaccard >= 0.85) reinforces the existing row instead of inserting", async () => {
      const { sql, pool } = await load();
      const first = await sql.insertFact(pool, {
        text: "the Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "meeting",
        confidence: 0.6,
      });
      // Same fact minus the leading "the": Jaccard 9/10 = 0.9 — different hash.
      const second = await sql.insertFact(pool, {
        text: "Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.8,
      });

      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = (await pool.query(`SELECT confidence FROM memories`)).rows as Array<{ confidence: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.8); // bumped to max of both
    });

    it("a provenance suffix on one copy does not defeat dedup (manual store vs conversation hook)", async () => {
      const { sql, pool } = await load();
      // memory_store bakes attribution into the text; the conversation hook
      // re-extracts the bare sentence. The suffix changes the hash AND dilutes
      // Jaccard below 0.85 — without provenance-stripping these double-capture.
      const manual = await sql.insertFact(pool, {
        text: 'Rahul Sharma\'s performance rating last cycle was "exceeds expectations" (stated by Dipesh, 2026-06-15).',
        category: "fact",
        sourceType: "manual",
        confidence: 0.9,
      });
      const hook = await sql.insertFact(pool, {
        text: 'Rahul Sharma\'s performance rating last cycle was "exceeds expectations".',
        category: "fact",
        sourceType: "conversation",
        confidence: 0.6,
      });

      expect(hook.deduped).toBe(true);
      expect(hook.id).toBe(manual.id);
      const rows = (await pool.query(`SELECT id FROM memories`)).rows as Array<{ id: number }>;
      expect(rows).toHaveLength(1);
    });

    it("provenance-stripping still inserts a second row when the cores genuinely differ", async () => {
      const { sql, pool } = await load();
      await sql.insertFact(pool, {
        text: "Placements weekly target is 45 offers (stated by Dipesh, 2026-06-14).",
        category: "metric",
        sourceType: "manual",
      });
      // Same provenance shape but a different number — must NOT dedup.
      const second = await sql.insertFact(pool, {
        text: "Placements weekly target is 50 offers (corrected by Dipesh, 2026-06-15).",
        category: "metric",
        sourceType: "manual",
      });
      expect(second.deduped).toBe(false);
      const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM memories`)).rows[0] as { n: number };
      expect(count.n).toBe(2);
    });

    it("a genuinely different fact inserts a second row", async () => {
      const { sql, pool } = await load();
      await sql.insertFact(pool, {
        text: "Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "meeting",
      });
      const second = await sql.insertFact(pool, {
        text: "Q4 admissions funnel conversion dropped to 11 percent",
        category: "metric",
        sourceType: "meeting",
      });
      expect(second.deduped).toBe(false);
      const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM memories`)).rows[0] as { n: number };
      expect(count.n).toBe(2);
    });

    it("exact re-assertion dedups via the content-hash ON CONFLICT upsert (keeps max confidence)", async () => {
      const { sql, pool } = await load();
      const first = await sql.insertFact(pool, {
        text: "NST Pune campus adds 4 new labs",
        category: "fact",
        sourceType: "meeting",
        confidence: 0.5,
      });

      const second = await sql.insertFact(pool, {
        text: "NST Pune campus adds 4 new labs",
        category: "fact",
        sourceType: "email",
        confidence: 0.85,
      });
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = (await pool.query(`SELECT confidence FROM memories`)).rows as Array<{ confidence: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.85);
    });
  });

  describe("forget / supersede / recent", () => {
    it("forgetMemory marks the row forgotten and hides it from search", async () => {
      const { sql, pool } = await load();
      const { id } = await sql.insertFact(pool, {
        text: "Old placement workflow uses spreadsheets",
        category: "fact",
        sourceType: "conversation",
      });

      await sql.forgetMemory(pool, id);

      const row = (
        await pool.query(`SELECT status FROM memories WHERE id = $1`, [id])
      ).rows[0] as { status: string };
      expect(row.status).toBe("forgotten");

      const hits = await sql.searchCandidates(pool, '"placement" OR "spreadsheets"');
      expect(hits).toHaveLength(0);
    });

    it("supersedeMemory inserts the new fact and marks the old one superseded", async () => {
      const { sql, dbMod } = await load();
      const old = await sql.insertFact(dbMod.getPool(), {
        text: "Q3 placement target is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-04-01T00:00:00.000Z",
      });

      const result = await sql.supersedeMemory(dbMod.getPool(), old.id, {
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-06-01T00:00:00.000Z",
      });

      expect(result.id).not.toBe(old.id);

      const oldRow = (
        await dbMod.getPool().query(`SELECT status, superseded_by FROM memories WHERE id = $1`, [old.id])
      ).rows[0] as { status: string; superseded_by: number };
      expect(oldRow.status).toBe("superseded");
      expect(oldRow.superseded_by).toBe(result.id);

      const newRow = (
        await dbMod.getPool().query(`SELECT status FROM memories WHERE id = $1`, [result.id])
      ).rows[0] as { status: string };
      expect(newRow.status).toBe("active");
    });

    it("supersedeMemory refuses a new fact whose assertedAt is older than the old one", async () => {
      const { sql, dbMod } = await load();
      const old = await sql.insertFact(dbMod.getPool(), {
        text: "Q3 placement target is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-04-01T00:00:00.000Z",
      });

      await expect(
        sql.supersedeMemory(dbMod.getPool(), old.id, {
          text: "Q3 placement target is 150 offers",
          category: "decision",
          sourceType: "meeting",
          assertedAt: "2026-01-01T00:00:00.000Z",
        })
      ).rejects.toThrow();

      const oldRow = (
        await dbMod.getPool().query(`SELECT status FROM memories WHERE id = $1`, [old.id])
      ).rows[0] as { status: string };
      expect(oldRow.status).toBe("active");
    });

    it("recentMemories returns active rows newest-first, capped at limit", async () => {
      const { sql, pool } = await load();
      await sql.insertFact(pool, { text: "fact alpha about admissions", category: "fact", sourceType: "manual", now: new Date("2026-06-01T00:00:00Z") });
      await sql.insertFact(pool, { text: "fact beta about placements", category: "fact", sourceType: "manual", now: new Date("2026-06-02T00:00:00Z") });
      const gamma = await sql.insertFact(pool, { text: "fact gamma about finance", category: "fact", sourceType: "manual", now: new Date("2026-06-03T00:00:00Z") });
      const delta = await sql.insertFact(pool, { text: "fact delta about hiring", category: "fact", sourceType: "manual", now: new Date("2026-06-04T00:00:00Z") });
      await sql.forgetMemory(pool, gamma.id);

      const recent = await sql.recentMemories(pool, 2);
      expect(recent).toHaveLength(2);
      expect(recent[0].id).toBe(delta.id);
      expect(recent[0].text).toBe("fact delta about hiring");
      expect(recent.map((r) => r.text)).not.toContain("fact gamma about finance");
    });
  });

  describe("cursors + ingested docs", () => {
    it("getCursor returns null for an unknown source; setCursor stores and overwrites", async () => {
      const { sql, pool } = await load();
      expect(await sql.getCursor(pool, "gmail")).toBeNull();

      await sql.setCursor(pool, "gmail", "hist-100");
      expect(await sql.getCursor(pool, "gmail")).toBe("hist-100");

      await sql.setCursor(pool, "gmail", "hist-200");
      expect(await sql.getCursor(pool, "gmail")).toBe("hist-200");

      const rows = (await pool.query(`SELECT * FROM ingest_cursors`)).rows;
      expect(rows).toHaveLength(1);
    });

    it("markIngested / isIngested / purgeIngested follow the joinStore pattern", async () => {
      const { sql, pool } = await load();
      const now = 10_000_000;
      const cutoff = now - 1000;

      expect(await sql.isIngested(pool, "doc-1")).toBe(false);
      await sql.markIngested(pool, "doc-1", now);
      expect(await sql.isIngested(pool, "doc-1")).toBe(true);

      // Duplicate mark must not throw (upsert).
      await expect(sql.markIngested(pool, "doc-1", now + 1)).resolves.toBeUndefined();

      await sql.markIngested(pool, "doc-old", cutoff - 1);
      await sql.markIngested(pool, "doc-boundary", cutoff);
      await sql.purgeIngested(pool, cutoff);

      expect(await sql.isIngested(pool, "doc-old")).toBe(false);
      expect(await sql.isIngested(pool, "doc-boundary")).toBe(true);
      expect(await sql.isIngested(pool, "doc-1")).toBe(true);
    });
  });

  describe("full-text sync + searchCandidates", () => {
    it("an inserted fact is findable via full-text and carries a negative bm score", async () => {
      const { sql, pool } = await load();
      const { id } = await sql.insertFact(pool, {
        text: "Average CTC for the 2026 placements batch is 12 LPA",
        category: "metric",
        sourceType: "meeting",
      });

      const hits = await sql.searchCandidates(pool, '"ctc" OR "placements"');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(id);
      expect(hits[0].text).toContain("Average CTC");
      // The convention (rank.ts: -bm = "higher is better") stores the lexical
      // score negated, so a real match's bm is <= 0.
      expect(hits[0].bm).toBeLessThanOrEqual(0);
      // camelCase row mapping
      expect(hits[0].sourceType).toBe("meeting");
      expect(hits[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("full-text index stays in sync on UPDATE of text (generated fts column)", async () => {
      const { sql, pool } = await load();
      const { id } = await sql.insertFact(pool, {
        text: "zebra metrics look stable",
        category: "fact",
        sourceType: "manual",
      });

      await pool.query(`UPDATE memories SET text = $1 WHERE id = $2`, ["yak metrics look stable", id]);

      expect(await sql.searchCandidates(pool, '"zebra"')).toHaveLength(0);
      const hits = await sql.searchCandidates(pool, '"yak"');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(id);
    });

    it("full-text index drops the row on DELETE", async () => {
      const { sql, pool } = await load();
      const { id } = await sql.insertFact(pool, {
        text: "walrus onboarding doc finalized",
        category: "fact",
        sourceType: "manual",
      });
      await pool.query(`DELETE FROM memories WHERE id = $1`, [id]);
      expect(await sql.searchCandidates(pool, '"walrus"')).toHaveLength(0);
    });

    it("excludes non-active rows from full-text results", async () => {
      const { sql, dbMod } = await load();
      const old = await sql.insertFact(dbMod.getPool(), {
        text: "hackathon budget is 2 lakh",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-01-01T00:00:00Z",
      });
      await sql.supersedeMemory(dbMod.getPool(), old.id, {
        text: "hackathon budget is 3 lakh",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-05-01T00:00:00Z",
      });

      const hits = await sql.searchCandidates(dbMod.getPool(), '"hackathon"');
      expect(hits).toHaveLength(1);
      expect(hits[0].text).toBe("hackathon budget is 3 lakh");
    });

    it("hostile user text sanitized via sanitizeFtsQuery never makes search throw", async () => {
      const { sql, pool } = await load();
      const { sanitizeFtsQuery } = await import("../src/memory/rank.js");
      await sql.insertFact(pool, {
        text: "Q3 plan: scale the NST placements pipeline to 300 active employers",
        category: "decision",
        sourceType: "meeting",
      });

      const hostile = [
        "what's the Q3 plan — placements/NST?",
        "salary (CTC) AND OR NOT \"weird\" query!!",
        "lead-to-enrollment *numbers* NEAR(placements)",
        "co-founder's review: (urgent) — what's pending?",
      ];
      for (const raw of hostile) {
        const q = sanitizeFtsQuery(raw);
        await expect(sql.searchCandidates(pool, q)).resolves.toBeDefined();
      }

      const hits = await sql.searchCandidates(pool, sanitizeFtsQuery("what's the Q3 plan — placements/NST?"));
      expect(hits.length).toBeGreaterThan(0);
    });

    it("returns [] for an empty query", async () => {
      const { sql, pool } = await load();
      await sql.insertFact(pool, { text: "anything at all here", category: "fact", sourceType: "manual" });
      expect(await sql.searchCandidates(pool, "")).toHaveLength(0);
      expect(await sql.searchCandidates(pool, "   ")).toHaveLength(0);
    });

    it("finds rows via the portable ts_rank / ILIKE fallback path", async () => {
      const { sql, pool } = await load();
      await sql.insertFact(pool, {
        text: "Employer summit venue must be booked by June 20",
        category: "deadline",
        sourceType: "email",
        now: new Date("2026-06-05T00:00:00Z"),
      });
      await sql.insertFact(pool, {
        text: "Old employer survey results archived",
        category: "fact",
        sourceType: "manual",
        now: new Date("2026-01-01T00:00:00Z"),
      });

      const hits = await sql.searchCandidates(pool, '"employer" OR "summit"');
      // Both rows mention "employer"; one also matches "summit".
      expect(hits.length).toBe(2);
      const texts = hits.map((h) => h.text);
      expect(texts.some((t) => t.includes("summit venue"))).toBe(true);
      expect(texts.some((t) => t.includes("survey results"))).toBe(true);
    });
  });

  describe("pruneMemories", () => {
    it("deletes only non-active rows older than the retention window", async () => {
      const { dbMod, sql, pool } = await load();
      const NOW = Date.parse("2026-06-01T00:00:00.000Z");
      const DAY = 24 * 60 * 60 * 1000;

      const oldForgotten = await sql.insertFact(pool, {
        text: "stale forgotten fact about hostel wifi",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 120 * DAY),
      });
      await sql.forgetMemory(pool, oldForgotten.id, new Date(NOW - 100 * DAY));

      const freshForgotten = await sql.insertFact(pool, {
        text: "recently forgotten fact about parking",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 10 * DAY),
      });
      await sql.forgetMemory(pool, freshForgotten.id, new Date(NOW - 5 * DAY));

      const oldActive = await sql.insertFact(pool, {
        text: "old but still active fact about curriculum",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 120 * DAY),
      });

      const deleted = await dbMod.pruneMemories(90, NOW);
      expect(deleted).toBe(1);

      const remaining = (await pool.query(`SELECT id FROM memories ORDER BY id`)).rows as Array<{ id: number }>;
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(freshForgotten.id);
      expect(ids).toContain(oldActive.id);
      expect(ids).not.toContain(oldForgotten.id);
    });

    it("prunes superseded chains without foreign-key errors", async () => {
      const { dbMod, sql, pool } = await load();
      const NOW = Date.parse("2026-06-01T00:00:00.000Z");
      const DAY = 24 * 60 * 60 * 1000;
      const old = new Date(NOW - 200 * DAY);

      const a = await sql.insertFact(pool, {
        text: "target v1 is 100 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-10-01T00:00:00Z",
        now: old,
      });
      const b = await sql.supersedeMemory(pool, a.id, {
        text: "target v2 is 150 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-11-01T00:00:00Z",
        now: new Date(NOW - 190 * DAY),
      });
      await sql.supersedeMemory(pool, b.id, {
        text: "target v3 is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-12-01T00:00:00Z",
        now: new Date(NOW - 180 * DAY),
      });

      let deleted = 0;
      await expect(
        (async () => {
          deleted = await dbMod.pruneMemories(90, NOW);
        })()
      ).resolves.toBeUndefined();
      expect(deleted).toBe(2);

      const remaining = (await pool.query(`SELECT text FROM memories`)).rows as Array<{ text: string }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].text).toBe("target v3 is 200 offers");
    });
  });
});
