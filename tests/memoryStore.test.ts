import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";

// Mock pino (same pattern as personaStoreRace.test.ts / dbMigration.test.ts)
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

async function load(): Promise<{ dbMod: DbModule; sql: SqlModule; db: Database.Database }> {
  const dbMod = await import("../src/state/db.js");
  const sql = await import("../src/memory/memorySql.js");
  const db = dbMod.getDb();
  return { dbMod, sql, db };
}

/** Drops the FTS table + its sync triggers, simulating an FTS-broken DB. */
function dropFts(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS memories_ai;
    DROP TRIGGER IF EXISTS memories_ad;
    DROP TRIGGER IF EXISTS memories_au;
    DROP TABLE IF EXISTS memories_fts;
  `);
}

describe("memory store (schema + memorySql)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
  });

  describe("migration", () => {
    it("creates the memories, ingest_cursors and ingested_docs tables", async () => {
      const { db } = await load();

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      expect(names).toContain("memories");
      expect(names).toContain("ingest_cursors");
      expect(names).toContain("ingested_docs");

      const cols = (db.pragma("table_info(memories)") as Array<{ name: string }>).map(
        (c) => c.name
      );
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
      const { db } = await load();
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_memories_hash");
      expect(names).toContain("idx_memories_status_created");
      expect(names).toContain("idx_memories_source");

      const hashIdx = (db.pragma("index_list('memories')") as Array<{ name: string; unique: number }>).find(
        (i) => i.name === "idx_memories_hash"
      );
      expect(hashIdx?.unique).toBe(1);
    });

    it("creates the FTS5 table + sync triggers and reports isFtsAvailable() === true", async () => {
      const { dbMod, db } = await load();
      expect(dbMod.isFtsAvailable()).toBe(true);

      const objects = db
        .prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'memories_%'")
        .all() as Array<{ name: string; type: string }>;
      const names = objects.map((o) => o.name);
      expect(names).toContain("memories_fts");
      expect(names).toContain("memories_ai");
      expect(names).toContain("memories_ad");
      expect(names).toContain("memories_au");
    });

    it("sets busy_timeout = 5000 on the connection", async () => {
      const { db } = await load();
      const timeout = db.pragma("busy_timeout", { simple: true });
      expect(timeout).toBe(5000);
    });

    it("is idempotent — re-running migrations on the same schema does not throw", async () => {
      const first = await import("../src/state/db.js");
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
      vi.doMock("../src/config.js", () => ({
        config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
      }));

      const second = await import("../src/state/db.js");
      expect(() => second.getDb()).not.toThrow();
      second.closeDb();
    });
  });

  describe("insertFact", () => {
    it("inserts a fact with defaults and returns { deduped: false, id }", async () => {
      const { sql, db } = await load();

      const result = sql.insertFact(db, {
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "meeting",
        sourceLabel: "Growth review",
      });

      expect(result.deduped).toBe(false);
      expect(result.id).toBeGreaterThan(0);

      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(result.id) as Record<string, unknown>;
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
      const { sql, db } = await load();
      const long = "placements update ".repeat(30); // 540 chars
      const result = sql.insertFact(db, {
        text: long,
        category: "fact",
        sourceType: "conversation",
      });
      const row = db.prepare("SELECT text FROM memories WHERE id = ?").get(result.id) as { text: string };
      expect(row.text.length).toBe(300);
      expect(row.text).toBe(long.slice(0, 300));
    });

    it("rejects empty / whitespace-only text", async () => {
      const { sql, db } = await load();
      expect(() =>
        sql.insertFact(db, { text: "   ", category: "fact", sourceType: "manual" })
      ).toThrow();
    });

    it("dedups on normalized content hash (case/punctuation-insensitive) and refreshes confidence + updated_at", async () => {
      const { sql, db } = await load();
      const t1 = new Date("2026-06-01T00:00:00.000Z");
      const t2 = new Date("2026-06-05T00:00:00.000Z");

      const first = sql.insertFact(db, {
        text: "Q3 attrition target is 5%",
        category: "metric",
        sourceType: "meeting",
        confidence: 0.6,
        now: t1,
      });
      const second = sql.insertFact(db, {
        text: "q3, ATTRITION target -- is 5",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.9,
        now: t2,
      });

      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = db.prepare("SELECT * FROM memories").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.9);
      expect(rows[0].updated_at).toBe(t2.toISOString());
    });

    it("dedup keeps the higher confidence when the re-assertion is weaker", async () => {
      const { sql, db } = await load();
      const first = sql.insertFact(db, {
        text: "May revenue closed at 9.4 crore",
        category: "metric",
        sourceType: "email",
        confidence: 0.9,
      });
      const second = sql.insertFact(db, {
        text: "may revenue closed at 9 4 crore",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.5,
      });
      expect(second.deduped).toBe(true);
      const row = db.prepare("SELECT confidence FROM memories WHERE id = ?").get(first.id) as { confidence: number };
      expect(row.confidence).toBe(0.9);
    });

    it("near-duplicate (Jaccard >= 0.85) reinforces the existing row instead of inserting", async () => {
      const { sql, db } = await load();
      const first = sql.insertFact(db, {
        text: "the Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "meeting",
        confidence: 0.6,
      });
      // Same fact minus the leading "the": Jaccard 9/10 = 0.9 — different hash.
      const second = sql.insertFact(db, {
        text: "Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "conversation",
        confidence: 0.8,
      });

      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = db.prepare("SELECT confidence FROM memories").all() as Array<{ confidence: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.8); // bumped to max of both
    });

    it("a genuinely different fact inserts a second row", async () => {
      const { sql, db } = await load();
      sql.insertFact(db, {
        text: "Q3 attrition target is 5 percent for placements team",
        category: "metric",
        sourceType: "meeting",
      });
      const second = sql.insertFact(db, {
        text: "Q4 admissions funnel conversion dropped to 11 percent",
        category: "metric",
        sourceType: "meeting",
      });
      expect(second.deduped).toBe(false);
      const count = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
      expect(count.n).toBe(2);
    });

    it("hash-conflict upsert still dedups when the FTS near-dup gate is unavailable", async () => {
      const { sql, db } = await load();
      const first = sql.insertFact(db, {
        text: "NST Pune campus adds 4 new labs",
        category: "fact",
        sourceType: "meeting",
        confidence: 0.5,
      });

      dropFts(db); // near-dup MATCH now throws; ON CONFLICT(content_hash) must catch the dup

      const second = sql.insertFact(db, {
        text: "NST Pune campus adds 4 new labs",
        category: "fact",
        sourceType: "email",
        confidence: 0.85,
      });
      expect(second.deduped).toBe(true);
      expect(second.id).toBe(first.id);

      const rows = db.prepare("SELECT confidence FROM memories").all() as Array<{ confidence: number }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].confidence).toBe(0.85);
    });
  });

  describe("forget / supersede / recent", () => {
    it("forgetMemory marks the row forgotten and hides it from search", async () => {
      const { sql, db } = await load();
      const { id } = sql.insertFact(db, {
        text: "Old placement workflow uses spreadsheets",
        category: "fact",
        sourceType: "conversation",
      });

      sql.forgetMemory(db, id);

      const row = db.prepare("SELECT status FROM memories WHERE id = ?").get(id) as { status: string };
      expect(row.status).toBe("forgotten");

      const hits = sql.searchCandidates(db, '"placement" OR "spreadsheets"');
      expect(hits).toHaveLength(0);
    });

    it("supersedeMemory inserts the new fact and marks the old one superseded", async () => {
      const { sql, db } = await load();
      const old = sql.insertFact(db, {
        text: "Q3 placement target is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-04-01T00:00:00.000Z",
      });

      const result = sql.supersedeMemory(db, old.id, {
        text: "Q3 placement target is 250 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-06-01T00:00:00.000Z",
      });

      expect(result.id).not.toBe(old.id);

      const oldRow = db.prepare("SELECT status, superseded_by FROM memories WHERE id = ?").get(old.id) as {
        status: string;
        superseded_by: number;
      };
      expect(oldRow.status).toBe("superseded");
      expect(oldRow.superseded_by).toBe(result.id);

      const newRow = db.prepare("SELECT status FROM memories WHERE id = ?").get(result.id) as { status: string };
      expect(newRow.status).toBe("active");
    });

    it("supersedeMemory refuses a new fact whose assertedAt is older than the old one", async () => {
      const { sql, db } = await load();
      const old = sql.insertFact(db, {
        text: "Q3 placement target is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-04-01T00:00:00.000Z",
      });

      expect(() =>
        sql.supersedeMemory(db, old.id, {
          text: "Q3 placement target is 150 offers",
          category: "decision",
          sourceType: "meeting",
          assertedAt: "2026-01-01T00:00:00.000Z",
        })
      ).toThrow();

      const oldRow = db.prepare("SELECT status FROM memories WHERE id = ?").get(old.id) as { status: string };
      expect(oldRow.status).toBe("active");
    });

    it("recentMemories returns active rows newest-first, capped at limit", async () => {
      const { sql, db } = await load();
      sql.insertFact(db, { text: "fact alpha about admissions", category: "fact", sourceType: "manual", now: new Date("2026-06-01T00:00:00Z") });
      sql.insertFact(db, { text: "fact beta about placements", category: "fact", sourceType: "manual", now: new Date("2026-06-02T00:00:00Z") });
      const gamma = sql.insertFact(db, { text: "fact gamma about finance", category: "fact", sourceType: "manual", now: new Date("2026-06-03T00:00:00Z") });
      const delta = sql.insertFact(db, { text: "fact delta about hiring", category: "fact", sourceType: "manual", now: new Date("2026-06-04T00:00:00Z") });
      sql.forgetMemory(db, gamma.id);

      const recent = sql.recentMemories(db, 2);
      expect(recent).toHaveLength(2);
      expect(recent[0].id).toBe(delta.id);
      expect(recent[0].text).toBe("fact delta about hiring");
      expect(recent.map((r) => r.text)).not.toContain("fact gamma about finance");
    });
  });

  describe("cursors + ingested docs", () => {
    it("getCursor returns null for an unknown source; setCursor stores and overwrites", async () => {
      const { sql, db } = await load();
      expect(sql.getCursor(db, "gmail")).toBeNull();

      sql.setCursor(db, "gmail", "hist-100");
      expect(sql.getCursor(db, "gmail")).toBe("hist-100");

      sql.setCursor(db, "gmail", "hist-200");
      expect(sql.getCursor(db, "gmail")).toBe("hist-200");

      const rows = db.prepare("SELECT * FROM ingest_cursors").all();
      expect(rows).toHaveLength(1);
    });

    it("markIngested / isIngested / purgeIngested follow the joinStore pattern", async () => {
      const { sql, db } = await load();
      const now = 10_000_000;
      const cutoff = now - 1000;

      expect(sql.isIngested(db, "doc-1")).toBe(false);
      sql.markIngested(db, "doc-1", now);
      expect(sql.isIngested(db, "doc-1")).toBe(true);

      // Duplicate mark must not throw (upsert).
      expect(() => sql.markIngested(db, "doc-1", now + 1)).not.toThrow();

      sql.markIngested(db, "doc-old", cutoff - 1);
      sql.markIngested(db, "doc-boundary", cutoff);
      sql.purgeIngested(db, cutoff);

      expect(sql.isIngested(db, "doc-old")).toBe(false);
      expect(sql.isIngested(db, "doc-boundary")).toBe(true);
      expect(sql.isIngested(db, "doc-1")).toBe(true);
    });
  });

  describe("FTS sync + searchCandidates", () => {
    it("an inserted fact is findable via MATCH and carries a negative bm25 score", async () => {
      const { sql, db } = await load();
      const { id } = sql.insertFact(db, {
        text: "Average CTC for the 2026 placements batch is 12 LPA",
        category: "metric",
        sourceType: "meeting",
      });

      const hits = sql.searchCandidates(db, '"ctc" OR "placements"');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(id);
      expect(hits[0].text).toContain("Average CTC");
      expect(hits[0].bm).toBeLessThan(0);
      // camelCase row mapping
      expect(hits[0].sourceType).toBe("meeting");
      expect(hits[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("FTS index stays in sync on UPDATE of text", async () => {
      const { sql, db } = await load();
      const { id } = sql.insertFact(db, {
        text: "zebra metrics look stable",
        category: "fact",
        sourceType: "manual",
      });

      db.prepare("UPDATE memories SET text = ? WHERE id = ?").run("yak metrics look stable", id);

      expect(sql.searchCandidates(db, '"zebra"')).toHaveLength(0);
      const hits = sql.searchCandidates(db, '"yak"');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe(id);
    });

    it("FTS index stays in sync on DELETE", async () => {
      const { sql, db } = await load();
      const { id } = sql.insertFact(db, {
        text: "walrus onboarding doc finalized",
        category: "fact",
        sourceType: "manual",
      });
      db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      expect(sql.searchCandidates(db, '"walrus"')).toHaveLength(0);
    });

    it("excludes non-active rows from MATCH results", async () => {
      const { sql, db } = await load();
      const old = sql.insertFact(db, {
        text: "hackathon budget is 2 lakh",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-01-01T00:00:00Z",
      });
      sql.supersedeMemory(db, old.id, {
        text: "hackathon budget is 3 lakh",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2026-05-01T00:00:00Z",
      });

      const hits = sql.searchCandidates(db, '"hackathon"');
      expect(hits).toHaveLength(1);
      expect(hits[0].text).toBe("hackathon budget is 3 lakh");
    });

    it("hostile user text sanitized via sanitizeFtsQuery never makes MATCH throw", async () => {
      const { sql, db } = await load();
      const { sanitizeFtsQuery } = await import("../src/memory/rank.js");
      sql.insertFact(db, {
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
        expect(() => sql.searchCandidates(db, q)).not.toThrow();
      }

      const hits = sql.searchCandidates(db, sanitizeFtsQuery("what's the Q3 plan — placements/NST?"));
      expect(hits.length).toBeGreaterThan(0);
    });

    it("returns [] for an empty query", async () => {
      const { sql, db } = await load();
      sql.insertFact(db, { text: "anything at all here", category: "fact", sourceType: "manual" });
      expect(sql.searchCandidates(db, "")).toHaveLength(0);
      expect(sql.searchCandidates(db, "   ")).toHaveLength(0);
    });

    it("falls back to a LIKE scan when the FTS table is missing (MATCH throws)", async () => {
      const { sql, db } = await load();
      sql.insertFact(db, {
        text: "Employer summit venue must be booked by June 20",
        category: "deadline",
        sourceType: "email",
        now: new Date("2026-06-05T00:00:00Z"),
      });
      sql.insertFact(db, {
        text: "Old employer survey results archived",
        category: "fact",
        sourceType: "manual",
        now: new Date("2026-01-01T00:00:00Z"),
      });

      dropFts(db);

      const hits = sql.searchCandidates(db, '"employer" OR "summit"');
      expect(hits).toHaveLength(2);
      // Constant bm in the fallback; ranked by recency (updated_at DESC).
      expect(hits[0].text).toContain("summit venue");
      expect(new Set(hits.map((h) => h.bm)).size).toBe(1);
    });
  });

  describe("FTS5 module unavailable (flag off)", () => {
    it("migration survives, isFtsAvailable() is false, and insert+search work via LIKE", async () => {
      // Simulate a SQLite build without the fts5 module: any DDL mentioning
      // fts5 throws during migration.
      vi.doMock("better-sqlite3", async (importOriginal) => {
        const actual = (await importOriginal()) as { default: new (...args: unknown[]) => Database.Database };
        const Real = actual.default;
        function NoFtsDatabase(this: unknown, ...args: unknown[]): Database.Database {
          const db = new Real(...args);
          const realExec = db.exec.bind(db);
          (db as { exec: (sql: string) => unknown }).exec = (sqlText: string) => {
            if (/fts5/i.test(sqlText)) {
              throw new Error("no such module: fts5");
            }
            return realExec(sqlText);
          };
          return db;
        }
        return { default: NoFtsDatabase };
      });

      const dbMod = await import("../src/state/db.js");
      const sql = await import("../src/memory/memorySql.js");

      let db!: Database.Database;
      expect(() => {
        db = dbMod.getDb();
      }).not.toThrow();
      expect(dbMod.isFtsAvailable()).toBe(false);

      const result = sql.insertFact(db, {
        text: "Placements team closed 45 offers in May",
        category: "metric",
        sourceType: "meeting",
      });
      expect(result.deduped).toBe(false);

      const hits = sql.searchCandidates(db, '"offers" OR "placements"');
      expect(hits).toHaveLength(1);
      expect(hits[0].text).toContain("45 offers");
    });
  });

  describe("pruneMemories", () => {
    it("deletes only non-active rows older than the retention window", async () => {
      const { dbMod, sql, db } = await load();
      const NOW = Date.parse("2026-06-01T00:00:00.000Z");
      const DAY = 24 * 60 * 60 * 1000;

      const oldForgotten = sql.insertFact(db, {
        text: "stale forgotten fact about hostel wifi",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 120 * DAY),
      });
      sql.forgetMemory(db, oldForgotten.id, new Date(NOW - 100 * DAY));

      const freshForgotten = sql.insertFact(db, {
        text: "recently forgotten fact about parking",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 10 * DAY),
      });
      sql.forgetMemory(db, freshForgotten.id, new Date(NOW - 5 * DAY));

      const oldActive = sql.insertFact(db, {
        text: "old but still active fact about curriculum",
        category: "fact",
        sourceType: "manual",
        now: new Date(NOW - 120 * DAY),
      });

      const deleted = dbMod.pruneMemories(90, NOW);
      expect(deleted).toBe(1);

      const remaining = db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{ id: number }>;
      const ids = remaining.map((r) => r.id);
      expect(ids).toContain(freshForgotten.id);
      expect(ids).toContain(oldActive.id);
      expect(ids).not.toContain(oldForgotten.id);
    });

    it("prunes superseded chains without foreign-key errors", async () => {
      const { dbMod, sql, db } = await load();
      const NOW = Date.parse("2026-06-01T00:00:00.000Z");
      const DAY = 24 * 60 * 60 * 1000;
      const old = new Date(NOW - 200 * DAY);

      const a = sql.insertFact(db, {
        text: "target v1 is 100 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-10-01T00:00:00Z",
        now: old,
      });
      const b = sql.supersedeMemory(db, a.id, {
        text: "target v2 is 150 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-11-01T00:00:00Z",
        now: new Date(NOW - 190 * DAY),
      });
      sql.supersedeMemory(db, b.id, {
        text: "target v3 is 200 offers",
        category: "decision",
        sourceType: "meeting",
        assertedAt: "2025-12-01T00:00:00Z",
        now: new Date(NOW - 180 * DAY),
      });

      let deleted = 0;
      expect(() => {
        deleted = dbMod.pruneMemories(90, NOW);
      }).not.toThrow();
      expect(deleted).toBe(2);

      const remaining = db.prepare("SELECT text FROM memories").all() as Array<{ text: string }>;
      expect(remaining).toHaveLength(1);
      expect(remaining[0].text).toBe("target v3 is 200 offers");
    });
  });
});
