import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

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
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent", ALLOWED_USER_IDS: ["U1"] },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const entitySql = await import("../src/memory/entitySql.js");
  const entityLink = await import("../src/memory/entityLink.js");
  const store = await import("../src/memory/memoryStore.js");
  const scope = await import("../src/access/scope.js");
  return { db: getPool(), entitySql, entityLink, store, scope };
}

async function insertMemory(db: Pool, text: string, opts: { sensitivity?: string; subject?: number } = {}): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  const id = (
    (await db.query(
      `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
       VALUES ($1, 'fact', 'manual', $2, $3, $4, $5) RETURNING id`,
      [text, opts.sensitivity ?? "normal", `h-${text}`, now, now]
    )).rows[0] as { id: number }
  ).id;
  if (opts.subject) await db.query("UPDATE memories SET subject_entity_id=$1 WHERE id=$2", [opts.subject, id]);
  return id;
}

async function memStatus(db: Pool, id: number): Promise<string> {
  return ((await db.query("SELECT status FROM memories WHERE id=$1", [id])).rows[0] as { status: string }).status;
}

describe("entity exclusions (right-to-be-forgotten)", () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => { ctx = await load(); });
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("forgetEntityMemories redacts active subject-linked rows and records an exclusion", async () => {
    const { db, entitySql } = ctx;
    const person = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const a = await insertMemory(db, "fact about rahul one", { subject: person.id });
    const b = await insertMemory(db, "fact about rahul two", { subject: person.id });
    const other = await insertMemory(db, "unrelated fact");

    const count = await entitySql.forgetEntityMemories(db, person.id);
    await entitySql.addEntityExclusion(db, person.id, "left the company", "U1");

    expect(count).toBe(2);
    expect(await memStatus(db, a)).toBe("forgotten");
    expect(await memStatus(db, b)).toBe("forgotten");
    expect(await memStatus(db, other)).toBe("active");
    expect(await entitySql.isEntityExcluded(db, person.id)).toBe(true);
  });

  it("forgetEntityMemories ALSO redacts active facts that name the entity in text but were never subject-linked (closes the keyword-search leak)", async () => {
    const { db, entitySql } = ctx;
    const person = await entitySql.createEntity(db, { type: "person", canonicalName: "Priya Nair" });
    // (a) subject-linked — caught by the original behavior
    const linked = await insertMemory(db, "Priya Nair owns the admissions funnel", { subject: person.id });
    // (b) NOT subject-linked, NOT in memory_entities — only her name in the text.
    //     This is the leak: forgetting the entity left this active + FTS-searchable.
    const orphan = await insertMemory(db, "Priya Nair is now mentoring the new admissions cohort");
    // (c) a fact about a different person — must stay active
    const other = await insertMemory(db, "Rahul Sharma leads the placements team");

    const count = await entitySql.forgetEntityMemories(db, person.id);

    expect(await memStatus(db, linked)).toBe("forgotten");
    expect(await memStatus(db, orphan)).toBe("forgotten"); // the keyword-search leak this fix closes
    expect(await memStatus(db, other)).toBe("active");
    expect(count).toBe(2);
  });

  it("does NOT text-redact on a generic single-token entity name (avoids collisions)", async () => {
    const { db, entitySql } = ctx;
    const generic = await entitySql.createEntity(db, { type: "project", canonicalName: "Drive" });
    const unrelated = await insertMemory(db, "The referral drive starts next week");
    const count = await entitySql.forgetEntityMemories(db, generic.id);
    expect(await memStatus(db, unrelated)).toBe("active"); // single generic token must not over-match
    expect(count).toBe(0);
  });

  it("linkFactEntities skips an excluded entity (no link, no subject)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const person = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await entitySql.addEntityExclusion(db, person.id, "forgotten", "U1");

    const m = await insertMemory(db, "Rahul Sharma did a thing");
    const res = await entityLink.linkFactEntities(db, m, {
      text: "Rahul Sharma did a thing", category: "owner", entities: ["Rahul Sharma"], sourceType: "manual",
    });
    expect(res.linked).toBe(0);
    expect(res.subjectEntityId).toBeNull();
    expect(await entitySql.getMemoryEntities(db, m)).toHaveLength(0);
  });

  it("FORGETS a fact whose subject is an excluded entity (text-level forget)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const person = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await entitySql.addEntityExclusion(db, person.id, "forgotten", "U1");
    const m = await insertMemory(db, "Rahul Sharma now owns the pricing project");
    const res = await entityLink.linkFactEntities(db, m, {
      text: "Rahul Sharma now owns the pricing project", category: "owner",
      entities: ["Rahul Sharma", "pricing project"], sourceType: "manual",
    });
    expect(res.forgotten).toBe(true);
    expect(await memStatus(db, m)).toBe("forgotten"); // its text would otherwise stay keyword-searchable
  });

  it("KEEPS a fact that only mentions an excluded entity (not its subject)", async () => {
    const { db, entitySql, entityLink } = ctx;
    const team = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const excluded = await entitySql.createEntity(db, { type: "person", canonicalName: "Priya Nair" });
    await entitySql.addEntityExclusion(db, excluded.id, "forgotten", "U1");
    const m = await insertMemory(db, "The placements team shipped the new dashboard, thanks to Priya Nair");
    const res = await entityLink.linkFactEntities(db, m, {
      text: "The placements team shipped the new dashboard, thanks to Priya Nair",
      category: "owner", entities: ["Placements Team", "Priya Nair"], sourceType: "manual",
    });
    expect(res.forgotten).toBeUndefined(); // subject is the team, not the excluded person
    expect(await memStatus(db, m)).toBe("active");
    // the excluded person is NOT linked, but the team is
    const linkedNames = (await entitySql.getMemoryEntities(db, m)).map((l) => l.entityId);
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
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("excludes sensitive facts from ambient recall by default", async () => {
    const { db, store, scope } = ctx;
    await insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    await insertMemory(db, "Compensation policy review scheduled", { sensitivity: "normal" });
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });

    const results = await store.searchMemories("compensation", 6, viewer);
    expect(results.some((r) => r.sensitivity === "sensitive")).toBe(false);
    expect(results.length).toBeGreaterThan(0); // the normal one still recalls
  });

  it("includes sensitive facts when MEMORY_SENSITIVE_RECALL=on", async () => {
    const { db, store, scope } = ctx;
    await insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    process.env.MEMORY_SENSITIVE_RECALL = "on";
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const results = await store.searchMemories("compensation", 6, viewer);
    expect(results.some((r) => r.sensitivity === "sensitive")).toBe(true);
    delete process.env.MEMORY_SENSITIVE_RECALL;
  });

  it("excludes sensitive facts from assembleRetrieval too", async () => {
    const { db, store, scope } = ctx;
    await insertMemory(db, "Compensation for Rahul is 90 LPA", { sensitivity: "sensitive" });
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const bundle = await store.assembleRetrieval("compensation", "U1", viewer);
    const all = [...bundle.queryFacts, ...bundle.entityFacts];
    expect(all.some((r) => r.sensitivity === "sensitive")).toBe(false);
  });
});
