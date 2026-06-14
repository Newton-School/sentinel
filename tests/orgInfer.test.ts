import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";
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

async function freshDb(): Promise<{ db: Database.Database; closeDb: () => void }> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  const { getDb, closeDb } = await import("../src/state/db.js");
  return { db: getDb(), closeDb };
}

function insertMemory(db: Database.Database, text: string, entities: string[], category = "owner"): number {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    db
      .prepare(
        `INSERT INTO memories (text, category, entities, source_type, content_hash, asserted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'meeting', ?, ?, ?, ?) RETURNING id`
      )
      .get(text, category, JSON.stringify(entities), `h-${text}`, now, now, now) as { id: number }
  ).id;
}

describe("linkFactEntities derives org edges", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("creates a 'manages' edge when a confident person owns a team", async () => {
    const { createEntity, getEdges } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const rahul = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });

    const m = insertMemory(db, "Rahul Sharma owns the placements team", [
      "Rahul Sharma",
      "Placements team",
    ]);
    linkFactEntities(db, m, {
      text: "Rahul Sharma owns the placements team",
      category: "owner",
      entities: ["Rahul Sharma", "Placements team"],
      sourceType: "meeting",
      assertedAt: "2026-06-14T00:00:00.000Z",
    });

    const edges = getEdges(db, { srcId: rahul.id, relation: "manages" });
    expect(edges).toHaveLength(1);
    expect(edges[0].assertedAt).toBe("2026-06-14T00:00:00.000Z");
    closeDb();
  });

  it("does not derive edges when the subject is not confidently resolved", async () => {
    const { getEdges } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    // Rahul is brand-new (created, confidence 0.5) → not a subject → no edges.
    const m = insertMemory(db, "Rahul Sharma owns the placements team", [
      "Rahul Sharma",
      "Placements team",
    ]);
    linkFactEntities(db, m, {
      text: "Rahul Sharma owns the placements team",
      category: "owner",
      entities: ["Rahul Sharma", "Placements team"],
      sourceType: "meeting",
    });
    expect(getEdges(db, { relation: "manages" })).toHaveLength(0);
    closeDb();
  });
});
