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

async function insertMemory(
  db: DbPool,
  text: string,
  category = "fact",
  entities: string[] = []
): Promise<{ id: number }> {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    await db.query(
      `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'manual', $4, $5, $6) RETURNING id`,
      [text, category, JSON.stringify(entities), `h-${text}`, now, now]
    )
  ).rows[0] as { id: number };
}

describe("entityLink.guessEntityType", () => {
  it("classifies team / project / metric / product names, else person", async () => {
    const { guessEntityType } = await import("../src/memory/entityLink.js");
    expect(guessEntityType("Placements Team")).toBe("team");
    expect(guessEntityType("Growth squad")).toBe("team");
    expect(guessEntityType("Q3 employer pipeline")).toBe("project");
    expect(guessEntityType("admissions funnel revamp")).toBe("project");
    expect(guessEntityType("CTC target")).toBe("metric");
    expect(guessEntityType("placement conversion rate")).toBe("metric");
    expect(guessEntityType("the mobile app")).toBe("product");
    expect(guessEntityType("Rahul Sharma")).toBe("person");
    expect(guessEntityType("Priya Nair")).toBe("person");
  });
});

describe("entityLink.linkFactEntities", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  it("links resolved entities, sets the confident exact match as subject", async () => {
    const { createEntity, getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });

    const m = await insertMemory(db, "Rahul Sharma owns placements", "owner", ["Rahul Sharma"]);
    const res = await linkFactEntities(db, m.id, {
      text: "Rahul Sharma owns placements",
      category: "owner",
      entities: ["Rahul Sharma"],
      sourceType: "manual",
    });

    expect(res.linked).toBe(1);
    expect(res.subjectEntityId).not.toBeNull();
    const links = await getMemoryEntities(db, m.id);
    expect(links[0].role).toBe("owner"); // owner category → owner role on subject

    const subjRow = (
      await db.query("SELECT subject_entity_id FROM memories WHERE id = $1", [m.id])
    ).rows[0] as { subject_entity_id: number | null };
    expect(subjRow.subject_entity_id).toBe(res.subjectEntityId);
    expect((await getEntityById(db, res.subjectEntityId!))?.canonicalName).toBe("Rahul Sharma");
  });

  it("creates a new person for an unseen 2-token name and links it", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const { getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const m = await insertMemory(db, "Anjali Mehta joined the data team", "fact", ["Anjali Mehta"]);
    const res = await linkFactEntities(db, m.id, {
      text: "Anjali Mehta joined the data team",
      category: "fact",
      entities: ["Anjali Mehta"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(1);
    const [link] = await getMemoryEntities(db, m.id);
    expect((await getEntityById(db, link.entityId))?.canonicalName).toBe("Anjali Mehta");
  });

  it("does not link or set a subject for an ambiguous bare name", async () => {
    const { createEntity, getMemoryEntities } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await createEntity(db, { type: "person", canonicalName: "Rahul Verma" });
    const m = await insertMemory(db, "Rahul shipped the feature", "fact", ["Rahul"]);
    const res = await linkFactEntities(db, m.id, {
      text: "Rahul shipped the feature",
      category: "fact",
      entities: ["Rahul"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(0);
    expect(res.subjectEntityId).toBeNull();
    expect(await getMemoryEntities(db, m.id)).toHaveLength(0);
  });

  it("links a fuzzy match as a mention (below subject threshold) and records the alias", async () => {
    const { createEntity, getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const e = await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const m = await insertMemory(db, "Rahul S led the review", "fact", ["Rahul S"]);
    const res = await linkFactEntities(db, m.id, {
      text: "Rahul S led the review",
      category: "fact",
      entities: ["Rahul S"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(1);
    expect(res.subjectEntityId).toBeNull(); // fuzzy confidence < 0.8
    expect((await getMemoryEntities(db, m.id))[0].role).toBe("mention");
    expect((await getEntityById(db, e.id))?.aliases).toContain("rahul s");
  });

  it("honors an extractor-declared subject over a higher-confidence pre-existing mention", async () => {
    const { createEntity, getEntityById, getEdges } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    // The OLD/negated owner already exists → resolves at 0.9; the NEW owner is
    // freshly created at 0.5. Without a declared subject the confidence-max
    // heuristic mis-picks the pre-existing entity.
    await createEntity(db, { type: "person", canonicalName: "Vikram Singh" });
    await createEntity(db, { type: "project", canonicalName: "mobile app revamp" });
    const text = "the mobile app revamp is now owned by Karthik Reddy, not Vikram Singh";
    const m = await insertMemory(db, text, "owner", ["Karthik Reddy", "Vikram Singh", "mobile app revamp"]);
    const res = await linkFactEntities(db, m.id, {
      text,
      category: "owner",
      entities: ["Karthik Reddy", "Vikram Singh", "mobile app revamp"],
      subject: "Karthik Reddy",
      sourceType: "manual",
    });

    expect((await getEntityById(db, res.subjectEntityId!))?.canonicalName).toBe("Karthik Reddy");
    const owns = await getEdges(db, { relation: "owns", status: "active" });
    expect(owns).toHaveLength(1);
    expect((await getEntityById(db, owns[0].srcId))?.canonicalName).toBe("Karthik Reddy");
  });

  it("falls back to the confidence-max heuristic when the declared subject doesn't resolve", async () => {
    const { createEntity, getEntityById } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const m = await insertMemory(db, "Rahul Sharma owns placements", "owner", ["Rahul Sharma"]);
    const res = await linkFactEntities(db, m.id, {
      text: "Rahul Sharma owns placements",
      category: "owner",
      entities: ["Rahul Sharma"],
      subject: "Someone Not Mentioned", // doesn't resolve → fallback
      sourceType: "manual",
    });
    expect((await getEntityById(db, res.subjectEntityId!))?.canonicalName).toBe("Rahul Sharma");
  });

  it("returns linked=0 for a fact with no entities", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const m = await insertMemory(db, "Some general statement", "fact", []);
    const res = await linkFactEntities(db, m.id, {
      text: "Some general statement",
      category: "fact",
      sourceType: "manual",
    });
    expect(res).toEqual({ linked: 0, subjectEntityId: null });
  });
});

describe("entityLink.retractFactEdges", () => {
  let db: DbPool;
  beforeEach(async () => {
    db = await freshDb();
  });
  afterEach(async () => {
    await closeDb();
  });

  async function loadMods() {
    const { linkFactEntities, retractFactEdges } = await import("../src/memory/entityLink.js");
    const { createEntity, getEdges } = await import("../src/memory/entitySql.js");
    return { linkFactEntities, retractFactEdges, createEntity, getEdges };
  }

  it("retires an ownership edge when its only supporting fact is retracted", async () => {
    const { linkFactEntities, retractFactEdges, createEntity, getEdges } = await loadMods();
    const anjali = await createEntity(db, { type: "person", canonicalName: "Anjali Mehta" });
    await createEntity(db, { type: "project", canonicalName: "website redesign project" });
    const m = await insertMemory(db, "Anjali Mehta owns the website redesign project", "owner", [
      "Anjali Mehta",
      "website redesign project",
    ]);
    await linkFactEntities(db, m.id, {
      text: "Anjali Mehta owns the website redesign project",
      category: "owner",
      entities: ["Anjali Mehta", "website redesign project"],
      sourceType: "manual",
    });
    expect(await getEdges(db, { srcId: anjali.id, status: "active" })).toHaveLength(1);

    const retracted = await retractFactEdges(db, m.id);
    expect(retracted).toBe(1);
    expect(await getEdges(db, { srcId: anjali.id, status: "active" })).toHaveLength(0);
    expect(await getEdges(db, { srcId: anjali.id, status: "superseded" })).toHaveLength(1);
  });

  it("only decrements an edge that still has other supporting facts", async () => {
    const { linkFactEntities, retractFactEdges, createEntity, getEdges } = await loadMods();
    const anjali = await createEntity(db, { type: "person", canonicalName: "Anjali Mehta" });
    await createEntity(db, { type: "project", canonicalName: "website redesign project" });
    const fact = {
      text: "Anjali Mehta owns the website redesign project",
      category: "owner" as const,
      entities: ["Anjali Mehta", "website redesign project"],
      sourceType: "manual" as const,
    };
    const m1 = await insertMemory(db, fact.text, "owner", fact.entities);
    const m2 = await insertMemory(db, fact.text + " (per the kickoff)", "owner", fact.entities);
    await linkFactEntities(db, m1.id, fact);
    await linkFactEntities(db, m2.id, fact); // same edge → evidence_count = 2

    await retractFactEdges(db, m1.id);
    const active = await getEdges(db, { srcId: anjali.id, status: "active" });
    expect(active).toHaveLength(1); // still supported by m2
    expect(active[0].evidenceCount).toBe(1);
  });

  it("is a no-op for a fact that derived no edges", async () => {
    const { retractFactEdges } = await import("../src/memory/entityLink.js");
    const m = await insertMemory(db, "Some general statement", "fact", []);
    expect(await retractFactEdges(db, m.id)).toBe(0);
  });
});

describe("entityLink — insertFact integration (gated)", () => {
  afterEach(async () => {
    delete process.env.MEMORY_ENTITY_GRAPH;
    await closeDb();
  });

  it("auto-links entities through insertFact when MEMORY_ENTITY_GRAPH=1", async () => {
    process.env.MEMORY_ENTITY_GRAPH = "1";
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb, getPool } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
    const { insertFact } = await import("../src/memory/memoryStore.js");
    const { getEntityMemoryIds, getResolutionCandidates } = await import("../src/memory/entitySql.js");

    const result = await insertFact({
      text: "Priya Nair owns the placements pipeline",
      category: "owner",
      entities: ["Priya Nair"],
      sourceType: "manual",
    });

    const [cand] = await getResolutionCandidates(getPool(), { rawName: "Priya Nair" });
    expect(cand).toBeDefined();
    expect(await getEntityMemoryIds(getPool(), cand.id)).toContain(result.id);
  });

  it("does NOT create entity links when the flag is unset (ships inert)", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb, getPool } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
    const { insertFact } = await import("../src/memory/memoryStore.js");

    await insertFact({
      text: "Priya Nair owns the placements pipeline",
      category: "owner",
      entities: ["Priya Nair"],
      sourceType: "manual",
    });

    const entityCount = Number(
      ((await getPool().query("SELECT COUNT(*) AS n FROM entities")).rows[0] as { n: number | string }).n
    );
    const linkCount = Number(
      ((await getPool().query("SELECT COUNT(*) AS n FROM memory_entities")).rows[0] as { n: number | string }).n
    );
    expect(entityCount).toBe(0);
    expect(linkCount).toBe(0);
  });
});
