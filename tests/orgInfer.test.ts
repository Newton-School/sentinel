import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { proposeEdgesForFact } from "../src/memory/orgInfer.js";

describe("orgInfer.proposeEdgesForFact (pure)", () => {
  it("derives person manages team from an owner fact", () => {
    const edges = proposeEdgesForFact({
      category: "owner",
      subject: { id: 1, type: "person" },
      others: [{ id: 2, type: "team" }],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ srcId: 1, dstId: 2, relation: "manages" });
  });

  it("derives person owns project/metric/product from an owner fact", () => {
    const edges = proposeEdgesForFact({
      category: "owner",
      subject: { id: 1, type: "person" },
      others: [
        { id: 2, type: "project" },
        { id: 3, type: "metric" },
      ],
    });
    expect(edges.map((e) => e.relation)).toEqual(["owns", "owns"]);
    expect(edges.map((e) => e.dstId)).toEqual([2, 3]);
  });

  it("derives team owns project from an owner fact", () => {
    const edges = proposeEdgesForFact({
      category: "owner",
      subject: { id: 5, type: "team" },
      others: [{ id: 6, type: "product" }],
    });
    expect(edges[0]).toMatchObject({ srcId: 5, dstId: 6, relation: "owns" });
  });

  it("emits nothing for a non-owner category", () => {
    expect(
      proposeEdgesForFact({
        category: "decision",
        subject: { id: 1, type: "person" },
        others: [{ id: 2, type: "team" }],
      })
    ).toEqual([]);
  });

  it("emits nothing without a confident subject", () => {
    expect(
      proposeEdgesForFact({
        category: "owner",
        subject: null,
        others: [{ id: 2, type: "team" }],
      })
    ).toEqual([]);
  });

  it("skips a self-edge and person→person pairs", () => {
    expect(
      proposeEdgesForFact({
        category: "owner",
        subject: { id: 1, type: "person" },
        others: [
          { id: 1, type: "person" }, // self
          { id: 2, type: "person" }, // person→person not a manages/owns target
        ],
      })
    ).toEqual([]);
  });
});

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function freshDb(): Promise<{ db: Pool }> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  return { db: getPool() };
}

async function insertMemory(db: Pool, text: string, entities: string[], category = "owner"): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    await db.query(
      `INSERT INTO memories (text, category, entities, source_type, content_hash, asserted_at, created_at, updated_at)
       VALUES ($1, $2, $3, 'meeting', $4, $5, $6, $7) RETURNING id`,
      [text, category, JSON.stringify(entities), `h-${text}`, now, now, now]
    )
  ).rows[0].id as number;
}

describe("linkFactEntities derives org edges", () => {
  let db: Pool;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("creates a 'manages' edge when a confident person owns a team", async () => {
    const { createEntity, getEdges } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const rahul = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });

    const m = await insertMemory(db, "Rahul Sharma owns the placements team", [
      "Rahul Sharma",
      "Placements team",
    ]);
    await linkFactEntities(db, m, {
      text: "Rahul Sharma owns the placements team",
      category: "owner",
      entities: ["Rahul Sharma", "Placements team"],
      sourceType: "meeting",
      assertedAt: "2026-06-14T00:00:00.000Z",
    });

    const edges = await getEdges(db, { srcId: rahul.id, relation: "manages" });
    expect(edges).toHaveLength(1);
    expect(edges[0].assertedAt).toBe("2026-06-14T00:00:00.000Z");
  });

  it("does not derive edges when the subject is not confidently resolved", async () => {
    const { getEdges } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    // Rahul is brand-new (created, confidence 0.5) → not a subject → no edges.
    const m = await insertMemory(db, "Rahul Sharma owns the placements team", [
      "Rahul Sharma",
      "Placements team",
    ]);
    await linkFactEntities(db, m, {
      text: "Rahul Sharma owns the placements team",
      category: "owner",
      entities: ["Rahul Sharma", "Placements team"],
      sourceType: "meeting",
    });
    expect(await getEdges(db, { relation: "manages" })).toHaveLength(0);
  });
});
