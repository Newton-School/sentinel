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
  const entitySql = await import("../src/memory/entitySql.js");
  const entityLink = await import("../src/memory/entityLink.js");
  const store = await import("../src/memory/memoryStore.js");
  const scope = await import("../src/access/scope.js");
  return { db: getDb(), entitySql, entityLink, store, scope };
}

function insertMemory(db: Database.Database, text: string, opts: { sensitivity?: string; subject?: number } = {}): number {
  const now = "2026-06-14T00:00:00.000Z";
  const id = (
    db.prepare(
      `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
       VALUES (?, 'fact', 'manual', ?, ?, ?, ?) RETURNING id`
    ).get(text, opts.sensitivity ?? "normal", `h-${text}`, now, now) as { id: number }
  ).id;
  if (opts.subject) db.prepare("UPDATE memories SET subject_entity_id=? WHERE id=?").run(opts.subject, id);
  return id;
}

describe("entity exclusions (right-to-be-forgotten)", () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => { ctx = await load(); });

  it("forgetEntityMemories redacts active subject-linked rows and records an exclusion", async () => {
    const { db, entitySql } = ctx;
    const person = entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const a = insertMemory(db, "fact about rahul one", { subject: person.id });
    const b = insertMemory(db, "fact about rahul two", { subject: person.id });
    const other = insertMemory(db, "unrelated fact");

    const count = entitySql.forgetEntityMemories(db, person.id);
    entitySql.addEntityExclusion(db, person.id, "left the company", "U1");

    expect(count).toBe(2);
    const status = (id: number) => (db.prepare("SELECT status FROM memories WHERE id=?").get(id) as { status: string }).status;
    expect(status(a)).toBe("forgotten");
    expect(status(b)).toBe("forgotten");
    expect(status(other)).toBe("active");
    expect(entitySql.isEntityExcluded(db, person.id)).toBe(true);
  });

  it("linkFactEntities skips an excluded entity (no link, no subject)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const person = entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    entitySql.addEntityExclusion(db, person.id, "forgotten", "U1");

    const m = insertMemory(db, "Rahul Sharma did a thing");
    const res = entityLink.linkFactEntities(db, m, {
      text: "Rahul Sharma did a thing", category: "owner", entities: ["Rahul Sharma"], sourceType: "manual",
    });
    expect(res.linked).toBe(0);
    expect(res.subjectEntityId).toBeNull();
    expect(entitySql.getMemoryEntities(db, m)).toHaveLength(0);
  });
});

describe("ambient sensitive-recall gating", () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    ctx = await load();
    delete process.env.MEMORY_SENSITIVE_RECALL;
    delete process.env.MEMORY_ACL_MODE;
  });

  it("excludes sensitive facts from ambient recall by default", async () => {
    const { db, store, scope } = ctx;
    insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    insertMemory(db, "Compensation policy review scheduled", { sensitivity: "normal" });
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });

    const results = store.searchMemories("compensation", 6, viewer);
    expect(results.some((r) => r.sensitivity === "sensitive")).toBe(false);
    expect(results.length).toBeGreaterThan(0); // the normal one still recalls
  });

  it("includes sensitive facts when MEMORY_SENSITIVE_RECALL=on", async () => {
    const { db, store, scope } = ctx;
    insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    process.env.MEMORY_SENSITIVE_RECALL = "on";
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const results = store.searchMemories("compensation", 6, viewer);
    expect(results.some((r) => r.sensitivity === "sensitive")).toBe(true);
    delete process.env.MEMORY_SENSITIVE_RECALL;
  });

  it("excludes sensitive facts from assembleRetrieval too", async () => {
    const { db, store, scope } = ctx;
    insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const bundle = store.assembleRetrieval("compensation", "U1", viewer);
    const all = [...bundle.queryFacts, ...bundle.entityFacts];
    expect(all.some((r) => r.sensitivity === "sensitive")).toBe(false);
  });
});
