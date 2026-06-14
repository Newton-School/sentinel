import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

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

function insertMemory(
  db: Database.Database,
  text: string,
  category = "fact",
  entities: string[] = []
): { id: number } {
  const now = "2026-06-14T00:00:00.000Z";
  return db
    .prepare(
      `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'manual', ?, ?, ?) RETURNING id`
    )
    .get(text, category, JSON.stringify(entities), `h-${text}`, now, now) as { id: number };
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
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("links resolved entities, sets the confident exact match as subject", async () => {
    const { createEntity, getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });

    const m = insertMemory(db, "Rahul Sharma owns placements", "owner", ["Rahul Sharma"]);
    const res = linkFactEntities(db, m.id, {
      text: "Rahul Sharma owns placements",
      category: "owner",
      entities: ["Rahul Sharma"],
      sourceType: "manual",
    });

    expect(res.linked).toBe(1);
    expect(res.subjectEntityId).not.toBeNull();
    const links = getMemoryEntities(db, m.id);
    expect(links[0].role).toBe("owner"); // owner category → owner role on subject

    const subjRow = (db.prepare("SELECT subject_entity_id FROM memories WHERE id = ?").get(m.id) as {
      subject_entity_id: number | null;
    });
    expect(subjRow.subject_entity_id).toBe(res.subjectEntityId);
    expect(getEntityById(db, res.subjectEntityId!)?.canonicalName).toBe("Rahul Sharma");
    closeDb();
  });

  it("creates a new person for an unseen 2-token name and links it", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const { getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const m = insertMemory(db, "Anjali Mehta joined the data team", "fact", ["Anjali Mehta"]);
    const res = linkFactEntities(db, m.id, {
      text: "Anjali Mehta joined the data team",
      category: "fact",
      entities: ["Anjali Mehta"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(1);
    const [link] = getMemoryEntities(db, m.id);
    expect(getEntityById(db, link.entityId)?.canonicalName).toBe("Anjali Mehta");
    closeDb();
  });

  it("does not link or set a subject for an ambiguous bare name", async () => {
    const { createEntity, getMemoryEntities } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    createEntity(db, { type: "person", canonicalName: "Rahul Verma" });
    const m = insertMemory(db, "Rahul shipped the feature", "fact", ["Rahul"]);
    const res = linkFactEntities(db, m.id, {
      text: "Rahul shipped the feature",
      category: "fact",
      entities: ["Rahul"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(0);
    expect(res.subjectEntityId).toBeNull();
    expect(getMemoryEntities(db, m.id)).toHaveLength(0);
    closeDb();
  });

  it("links a fuzzy match as a mention (below subject threshold) and records the alias", async () => {
    const { createEntity, getMemoryEntities, getEntityById } = await import("../src/memory/entitySql.js");
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const e = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const m = insertMemory(db, "Rahul S led the review", "fact", ["Rahul S"]);
    const res = linkFactEntities(db, m.id, {
      text: "Rahul S led the review",
      category: "fact",
      entities: ["Rahul S"],
      sourceType: "manual",
    });
    expect(res.linked).toBe(1);
    expect(res.subjectEntityId).toBeNull(); // fuzzy confidence < 0.8
    expect(getMemoryEntities(db, m.id)[0].role).toBe("mention");
    expect(getEntityById(db, e.id)?.aliases).toContain("rahul s");
    closeDb();
  });

  it("returns linked=0 for a fact with no entities", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const m = insertMemory(db, "Some general statement", "fact", []);
    const res = linkFactEntities(db, m.id, {
      text: "Some general statement",
      category: "fact",
      sourceType: "manual",
    });
    expect(res).toEqual({ linked: 0, subjectEntityId: null });
    closeDb();
  });
});

describe("entityLink — insertFact integration (gated)", () => {
  beforeEach(() => {
    delete process.env.MEMORY_ENTITY_GRAPH;
  });

  it("auto-links entities through insertFact when MEMORY_ENTITY_GRAPH=1", async () => {
    process.env.MEMORY_ENTITY_GRAPH = "1";
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
    const { getDb, closeDb } = await import("../src/state/db.js");
    const { insertFact } = await import("../src/memory/memoryStore.js");
    const { getEntityMemoryIds, getResolutionCandidates } = await import("../src/memory/entitySql.js");

    const result = insertFact({
      text: "Priya Nair owns the placements pipeline",
      category: "owner",
      entities: ["Priya Nair"],
      sourceType: "manual",
    });

    const [cand] = getResolutionCandidates(getDb(), { rawName: "Priya Nair" });
    expect(cand).toBeDefined();
    expect(getEntityMemoryIds(getDb(), cand.id)).toContain(result.id);
    delete process.env.MEMORY_ENTITY_GRAPH;
    closeDb();
  });

  it("does NOT create entity links when the flag is unset (ships inert)", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
    const { getDb, closeDb } = await import("../src/state/db.js");
    const { insertFact } = await import("../src/memory/memoryStore.js");

    insertFact({
      text: "Priya Nair owns the placements pipeline",
      category: "owner",
      entities: ["Priya Nair"],
      sourceType: "manual",
    });

    const entityCount = (getDb().prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number }).n;
    const linkCount = (getDb().prepare("SELECT COUNT(*) AS n FROM memory_entities").get() as { n: number }).n;
    expect(entityCount).toBe(0);
    expect(linkCount).toBe(0);
    closeDb();
  });
});
