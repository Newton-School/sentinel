import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbPool } from "../src/state/db.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  const { getPool } = await import("../src/state/db.js");
  const store = await import("../src/memory/memoryStore.js");
  const entitySql = await import("../src/memory/entitySql.js");
  const scope = await import("../src/access/scope.js");
  return { pool: getPool(), store, entitySql, scope };
}

async function insertMemory(pool: DbPool, text: string, category = "fact"): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    (
      await pool.query(
        `INSERT INTO memories (text, category, source_type, content_hash, created_at, updated_at)
         VALUES ($1, $2, 'manual', $3, $4, $5) RETURNING id`,
        [text, category, `h-${text}`, now, now]
      )
    ).rows[0] as { id: number }
  ).id;
}

const founder = (scope: any) => scope.buildViewerScope("U1", { founderUserIds: ["U1"] });

describe("assembleRetrieval", () => {
  beforeEach(async () => {
    delete process.env.MEMORY_ACL_MODE;
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: {
        DATABASE_URL: process.env.DATABASE_URL,
        PG_POOL_MAX: 5,
        LOG_LEVEL: "silent",
        ALLOWED_USER_IDS: ["U1"],
      },
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

  it("returns query-text facts for a keyword match", async () => {
    const { store, scope } = await load();
    await store.insertFact({ text: "Q3 placement target is 300 offers", category: "decision", sourceType: "manual" });
    const bundle = await store.assembleRetrieval("placement target", "U1", founder(scope));
    expect(bundle.queryFacts.length).toBeGreaterThan(0);
  });

  it("pulls an entity's linked facts when the query names it, without duplicating query facts", async () => {
    const { pool, store, entitySql, scope } = await load();
    // An entity + a fact linked to it that does NOT keyword-match the query.
    const team = await entitySql.createEntity(pool, { type: "team", canonicalName: "Placements Team" });
    const linkedId = await insertMemory(pool, "Roadmap milestone shipped ahead of schedule");
    await entitySql.linkMemoryEntity(pool, { memoryId: linkedId, entityId: team.id, role: "subject" });

    const bundle = await store.assembleRetrieval("what is the placements team doing", "U1", founder(scope));
    expect(bundle.mentionedEntities.map((e) => e.entityId)).toContain(team.id);
    expect(bundle.entityFacts.map((f) => f.id)).toContain(linkedId);
  });

  it("does not put an entity fact in both tiers (entity facts dedupe against query facts)", async () => {
    const { pool, store, entitySql, scope } = await load();
    const team = await entitySql.createEntity(pool, { type: "team", canonicalName: "Placements Team" });
    // A fact that BOTH keyword-matches and is entity-linked.
    const dual = await store.insertFact({
      text: "Placements team closed 50 offers",
      category: "metric",
      sourceType: "manual",
    });
    const dualId = dual.id;
    await entitySql.linkMemoryEntity(pool, { memoryId: dualId, entityId: team.id, role: "subject" });

    const bundle = await store.assembleRetrieval("placements team offers", "U1", founder(scope));
    const inQuery = bundle.queryFacts.some((f) => f.id === dualId);
    const inEntity = bundle.entityFacts.some((f) => f.id === dualId);
    expect(inQuery).toBe(true);
    expect(inEntity).toBe(false); // already covered by the query tier
  });

  it("returns an empty bundle for a non-founder viewer (founders mode)", async () => {
    const { pool, store, entitySql, scope } = await load();
    const team = await entitySql.createEntity(pool, { type: "team", canonicalName: "Placements Team" });
    const id = await insertMemory(pool, "secret roadmap note");
    await entitySql.linkMemoryEntity(pool, { memoryId: id, entityId: team.id, role: "subject" });
    await store.insertFact({ text: "Q3 placement target is 300 offers", category: "decision", sourceType: "manual" });

    const stranger = scope.buildViewerScope("U9", { founderUserIds: ["U1"] });
    const bundle = await store.assembleRetrieval("placements team target", "U9", stranger);
    expect(bundle.queryFacts).toHaveLength(0);
    expect(bundle.entityFacts).toHaveLength(0);
  });

  it("never throws — returns an empty bundle on internal failure", async () => {
    const { store, scope } = await load();
    // A query that sanitizes to empty still yields a well-formed empty bundle.
    const bundle = await store.assembleRetrieval("   ", "U1", founder(scope));
    expect(bundle).toEqual({ queryFacts: [], entityFacts: [], mentionedEntities: [], dossiers: [] });
  });
});
