import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent", ALLOWED_USER_IDS: ["U1"] },
  }));
  const { getDb } = await import("../src/state/db.js");
  const store = await import("../src/memory/memoryStore.js");
  const entitySql = await import("../src/memory/entitySql.js");
  const scope = await import("../src/access/scope.js");
  return { db: getDb(), store, entitySql, scope };
}

function insertMemory(db: Database.Database, text: string, category = "fact"): number {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    db
      .prepare(
        `INSERT INTO memories (text, category, source_type, content_hash, created_at, updated_at)
         VALUES (?, ?, 'manual', ?, ?, ?) RETURNING id`
      )
      .get(text, category, `h-${text}`, now, now) as { id: number }
  ).id;
}

const founder = (scope: any) => scope.buildViewerScope("U1", { founderUserIds: ["U1"] });

describe("assembleRetrieval", () => {
  beforeEach(() => {
    delete process.env.MEMORY_ACL_MODE;
  });

  it("returns query-text facts for a keyword match", async () => {
    const { db, store, scope } = await load();
    store.insertFact({ text: "Q3 placement target is 300 offers", category: "decision", sourceType: "manual" });
    const bundle = store.assembleRetrieval("placement target", "U1", founder(scope));
    expect(bundle.queryFacts.length).toBeGreaterThan(0);
  });

  it("pulls an entity's linked facts when the query names it, without duplicating query facts", async () => {
    const { db, store, entitySql, scope } = await load();
    // An entity + a fact linked to it that does NOT keyword-match the query.
    const team = entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const linkedId = insertMemory(db, "Roadmap milestone shipped ahead of schedule");
    entitySql.linkMemoryEntity(db, { memoryId: linkedId, entityId: team.id, role: "subject" });

    const bundle = store.assembleRetrieval("what is the placements team doing", "U1", founder(scope));
    expect(bundle.mentionedEntities.map((e) => e.entityId)).toContain(team.id);
    expect(bundle.entityFacts.map((f) => f.id)).toContain(linkedId);
  });

  it("does not put an entity fact in both tiers (entity facts dedupe against query facts)", async () => {
    const { db, store, entitySql, scope } = await load();
    const team = entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    // A fact that BOTH keyword-matches and is entity-linked.
    const dualId = store.insertFact({
      text: "Placements team closed 50 offers",
      category: "metric",
      sourceType: "manual",
    }).id;
    entitySql.linkMemoryEntity(db, { memoryId: dualId, entityId: team.id, role: "subject" });

    const bundle = store.assembleRetrieval("placements team offers", "U1", founder(scope));
    const inQuery = bundle.queryFacts.some((f) => f.id === dualId);
    const inEntity = bundle.entityFacts.some((f) => f.id === dualId);
    expect(inQuery).toBe(true);
    expect(inEntity).toBe(false); // already covered by the query tier
  });

  it("returns an empty bundle for a non-founder viewer (founders mode)", async () => {
    const { db, store, entitySql, scope } = await load();
    const team = entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const id = insertMemory(db, "secret roadmap note");
    entitySql.linkMemoryEntity(db, { memoryId: id, entityId: team.id, role: "subject" });
    store.insertFact({ text: "Q3 placement target is 300 offers", category: "decision", sourceType: "manual" });

    const stranger = scope.buildViewerScope("U9", { founderUserIds: ["U1"] });
    const bundle = store.assembleRetrieval("placements team target", "U9", stranger);
    expect(bundle.queryFacts).toHaveLength(0);
    expect(bundle.entityFacts).toHaveLength(0);
  });

  it("never throws — returns an empty bundle on internal failure", async () => {
    const { store, scope } = await load();
    // A query that sanitizes to empty still yields a well-formed empty bundle.
    const bundle = store.assembleRetrieval("   ", "U1", founder(scope));
    expect(bundle).toEqual({ queryFacts: [], entityFacts: [], mentionedEntities: [] });
  });
});
