import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbPool } from "../src/state/db.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function freshDb(): Promise<DbPool> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  return getPool();
}

async function closeDb(): Promise<void> {
  const { closeDb } = await import("../src/state/db.js");
  await closeDb();
}

// Insert a bare memory row directly so memory_entities FK is satisfiable.
async function insertMemory(db: DbPool, text: string): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  const row = (
    await db.query(
      `INSERT INTO memories (text, category, source_type, content_hash, created_at, updated_at)
       VALUES ($1, 'fact', 'manual', $2, $3, $4) RETURNING id`,
      [text, `hash-${text}`, now, now]
    )
  ).rows[0] as { id: number };
  return row.id;
}

describe("entitySql — entity CRUD + candidates", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("creates an entity and round-trips it (normalized name, empty aliases)", async () => {
    const { createEntity, getEntityById } = await import("../src/memory/entitySql.js");
    const e = await createEntity(db, {
      type: "person",
      canonicalName: "Rahul Sharma",
      slackUserId: "U1",
      now: new Date("2026-06-14T00:00:00.000Z"),
    });
    expect(e.id).toBeGreaterThan(0);
    expect(e.normalizedName).toBe("rahul sharma");
    expect(e.aliases).toEqual([]);
    expect(e.status).toBe("active");
    expect(e.visibility).toBe("founders");

    const got = await getEntityById(db, e.id);
    expect(got?.canonicalName).toBe("Rahul Sharma");
    expect(got?.slackUserId).toBe("U1");
  });

  it("getResolutionCandidates finds by hard key and by shared name token, excluding merged", async () => {
    const { createEntity, getResolutionCandidates } = await import("../src/memory/entitySql.js");
    const rahul = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma", slackUserId: "U1" });
    await createEntity(db, { type: "person", canonicalName: "Priya Nair", email: "priya@newtonschool.co" });
    const merged = await createEntity(db, { type: "person", canonicalName: "Rahul Old" });
    await db.query(`UPDATE entities SET status='merged' WHERE id = $1`, [merged.id]);

    const byKey = await getResolutionCandidates(db, { rawName: "whoever", slackUserId: "U1" });
    expect(byKey.map((c) => c.id)).toContain(rahul.id);

    const byToken = await getResolutionCandidates(db, { rawName: "Rahul" });
    const ids = byToken.map((c) => c.id);
    expect(ids).toContain(rahul.id);
    expect(ids).not.toContain(merged.id); // merged rows are excluded
  });

  it("attachIdentity sets a missing hard key but never overwrites an existing one", async () => {
    const { createEntity, attachIdentity, getEntityById } = await import("../src/memory/entitySql.js");
    const e = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await attachIdentity(db, e.id, { slackUserId: "U1", email: "rahul@newtonschool.co" });
    let got = await getEntityById(db, e.id);
    expect(got?.slackUserId).toBe("U1");
    expect(got?.email).toBe("rahul@newtonschool.co");
    // second attach must not overwrite
    await attachIdentity(db, e.id, { slackUserId: "U2" });
    got = await getEntityById(db, e.id);
    expect(got?.slackUserId).toBe("U1");
  });

  it("addAlias appends a unique alias and is idempotent", async () => {
    const { createEntity, addAlias, getEntityById } = await import("../src/memory/entitySql.js");
    const e = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await addAlias(db, e.id, "rahul s");
    await addAlias(db, e.id, "rahul s"); // dup — no-op
    await addAlias(db, e.id, "r sharma");
    const got = await getEntityById(db, e.id);
    expect(got?.aliases.sort()).toEqual(["r sharma", "rahul s"]);
  });
});

describe("entitySql — fact↔entity links", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("links memories to entities, ignores exact-duplicate links, and reverse-looks-up", async () => {
    const { createEntity, linkMemoryEntity, getEntityMemoryIds, getMemoryEntities } =
      await import("../src/memory/entitySql.js");
    const e = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const m = await insertMemory(db, "Rahul owns placements");

    await linkMemoryEntity(db, { memoryId: m, entityId: e.id, role: "owner", confidence: 0.9 });
    await linkMemoryEntity(db, { memoryId: m, entityId: e.id, role: "owner", confidence: 0.9 }); // dup

    expect(await getEntityMemoryIds(db, e.id)).toEqual([m]);
    const links = await getMemoryEntities(db, m);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ entityId: e.id, role: "owner" });
  });
});

describe("entitySql — edges (persona-style confidence growth)", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("first upsert inserts at base confidence; re-upserts grow asymptotically and bump evidence_count", async () => {
    const { createEntity, upsertEdge, getEdges } = await import("../src/memory/entitySql.js");
    const a = await createEntity(db, { type: "person", canonicalName: "Report" });
    const b = await createEntity(db, { type: "person", canonicalName: "Manager" });

    const first = await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", confidence: 0.5 });
    expect(first.created).toBe(true);
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", confidence: 0.5 });

    const edges = await getEdges(db, { srcId: a.id, relation: "reports_to" });
    expect(edges).toHaveLength(1);
    expect(edges[0].evidenceCount).toBe(2);
    // 0.5 → MAX(MIN(0.5 + 0.5*0.15, .95), 0.5) = 0.575
    expect(edges[0].confidence).toBeCloseTo(0.575, 5);
  });

  it("keeps the most recent asserted_at and never regresses to an older one", async () => {
    const { createEntity, upsertEdge, getEdges } = await import("../src/memory/entitySql.js");
    const a = await createEntity(db, { type: "person", canonicalName: "A" });
    const b = await createEntity(db, { type: "person", canonicalName: "B" });
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", assertedAt: "2026-01-01T00:00:00.000Z" });
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", assertedAt: "2026-06-01T00:00:00.000Z" });
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", assertedAt: "2026-03-01T00:00:00.000Z" });
    const [edge] = await getEdges(db, { srcId: a.id });
    expect(edge.assertedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("a high-confidence assertion pulls the edge up immediately", async () => {
    const { createEntity, upsertEdge, getEdges } = await import("../src/memory/entitySql.js");
    const a = await createEntity(db, { type: "person", canonicalName: "A" });
    const b = await createEntity(db, { type: "person", canonicalName: "B" });
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", confidence: 0.5 });
    await upsertEdge(db, { srcId: a.id, dstId: b.id, relation: "reports_to", confidence: 0.95 });
    const [edge] = await getEdges(db, { srcId: a.id });
    expect(edge.confidence).toBeCloseTo(0.95, 5);
  });
});

describe("entitySql — mergeEntities", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("re-points links, folds duplicate edges, unions aliases, copies keys, tombstones loser", async () => {
    const { createEntity, addAlias, linkMemoryEntity, upsertEdge, mergeEntities, getEntityById, getEntityMemoryIds, getEdges } =
      await import("../src/memory/entitySql.js");

    const winner = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma", slackUserId: "U1" });
    const loser = await createEntity(db, { type: "person", canonicalName: "Rahul S", email: "rahul@newtonschool.co" });
    const dst = await createEntity(db, { type: "team", canonicalName: "Placements" });

    await addAlias(db, loser.id, "r sharma");
    const m1 = await insertMemory(db, "fact about rahul one");
    const m2 = await insertMemory(db, "fact about rahul two");
    await linkMemoryEntity(db, { memoryId: m1, entityId: winner.id, role: "subject" });
    await linkMemoryEntity(db, { memoryId: m2, entityId: loser.id, role: "subject" });

    // both have a member_of edge to the same team → must fold on merge
    await upsertEdge(db, { srcId: winner.id, dstId: dst.id, relation: "member_of", confidence: 0.6 });
    await upsertEdge(db, { srcId: loser.id, dstId: dst.id, relation: "member_of", confidence: 0.8 });

    await mergeEntities(db, loser.id, winner.id);

    // loser tombstoned, pointing at winner
    const loserRow = await getEntityById(db, loser.id);
    expect(loserRow?.status).toBe("merged");
    expect(loserRow?.mergedInto).toBe(winner.id);

    // winner now owns both memories
    expect((await getEntityMemoryIds(db, winner.id)).sort()).toEqual([m1, m2].sort());

    // aliases unioned (loser canonical + its alias folded into winner)
    const winnerRow = await getEntityById(db, winner.id);
    expect(winnerRow?.aliases).toEqual(expect.arrayContaining(["rahul s", "r sharma"]));
    // winner kept its own key; loser's email copied since winner lacked one
    expect(winnerRow?.slackUserId).toBe("U1");
    expect(winnerRow?.email).toBe("rahul@newtonschool.co");

    // single folded edge to the team at MAX confidence
    const edges = await getEdges(db, { dstId: dst.id, relation: "member_of", status: "active" });
    const winnerEdges = edges.filter((e) => e.srcId === winner.id);
    expect(winnerEdges).toHaveLength(1);
    expect(winnerEdges[0].confidence).toBeCloseTo(0.8, 5);
    // loser has no active edges left
    expect(await getEdges(db, { srcId: loser.id, status: "active" })).toHaveLength(0);
  });

  it("refuses to merge an entity into itself", async () => {
    const { createEntity, mergeEntities } = await import("../src/memory/entitySql.js");
    const e = await createEntity(db, { type: "person", canonicalName: "Solo" });
    await expect(mergeEntities(db, e.id, e.id)).rejects.toThrow();
  });
});
