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

  it("forgetEntityMemories ALSO redacts active facts that name the entity in text but were never subject-linked (closes the keyword-search leak)", async () => {
    const { db, entitySql } = ctx;
    const person = entitySql.createEntity(db, { type: "person", canonicalName: "Priya Nair" });
    // (a) subject-linked — caught by the original behavior
    const linked = insertMemory(db, "Priya Nair owns the admissions funnel", { subject: person.id });
    // (b) NOT subject-linked, NOT in memory_entities — only her name in the text.
    //     This is the leak: forgetting the entity left this active + FTS-searchable.
    const orphan = insertMemory(db, "Priya Nair is now mentoring the new admissions cohort");
    // (c) a fact about a different person — must stay active
    const other = insertMemory(db, "Rahul Sharma leads the placements team");

    const count = entitySql.forgetEntityMemories(db, person.id);

    const status = (id: number) => (db.prepare("SELECT status FROM memories WHERE id=?").get(id) as { status: string }).status;
    expect(status(linked)).toBe("forgotten");
    expect(status(orphan)).toBe("forgotten"); // the keyword-search leak this fix closes
    expect(status(other)).toBe("active");
    expect(count).toBe(2);
  });

  it("does NOT text-redact on a generic single-token entity name (avoids collisions)", async () => {
    const { db, entitySql } = ctx;
    const generic = entitySql.createEntity(db, { type: "project", canonicalName: "Drive" });
    const unrelated = insertMemory(db, "The referral drive starts next week");
    const count = entitySql.forgetEntityMemories(db, generic.id);
    const status = (db.prepare("SELECT status FROM memories WHERE id=?").get(unrelated) as { status: string }).status;
    expect(status).toBe("active"); // single generic token must not over-match
    expect(count).toBe(0);
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

  it("FORGETS a fact whose subject is an excluded entity (text-level forget)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const person = entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    entitySql.addEntityExclusion(db, person.id, "forgotten", "U1");
    const m = insertMemory(db, "Rahul Sharma now owns the pricing project");
    const res = entityLink.linkFactEntities(db, m, {
      text: "Rahul Sharma now owns the pricing project", category: "owner",
      entities: ["Rahul Sharma", "pricing project"], sourceType: "manual",
    });
    expect(res.forgotten).toBe(true);
    const status = (db.prepare("SELECT status FROM memories WHERE id=?").get(m) as { status: string }).status;
    expect(status).toBe("forgotten"); // its text would otherwise stay keyword-searchable
  });

  it("KEEPS a fact that only mentions an excluded entity (not its subject)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const team = entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const excluded = entitySql.createEntity(db, { type: "person", canonicalName: "Priya Nair" });
    entitySql.addEntityExclusion(db, excluded.id, "forgotten", "U1");
    const m = insertMemory(db, "The placements team shipped the new dashboard, thanks to Priya Nair");
    const res = entityLink.linkFactEntities(db, m, {
      text: "The placements team shipped the new dashboard, thanks to Priya Nair",
      category: "owner", entities: ["Placements Team", "Priya Nair"], sourceType: "manual",
    });
    expect(res.forgotten).toBeUndefined(); // subject is the team, not the excluded person
    const status = (db.prepare("SELECT status FROM memories WHERE id=?").get(m) as { status: string }).status;
    expect(status).toBe("active");
    // the excluded person is NOT linked, but the team is
    const linkedNames = entitySql.getMemoryEntities(db, m).map((l) => l.entityId);
    expect(linkedNames).toContain(team.id);
    expect(linkedNames).not.toContain(excluded.id);
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
