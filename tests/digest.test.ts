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
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const entitySql = await import("../src/memory/entitySql.js");
  const digest = await import("../src/memory/digest.js");
  const scope = await import("../src/access/scope.js");
  return { db: getPool(), entitySql, digest, scope };
}

async function insertFact(
  db: DbPool,
  text: string,
  createdAt: string,
  opts: { subject?: number; sensitivity?: string } = {}
): Promise<number> {
  const id = (
    (
      await db.query(
        `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
         VALUES ($1, 'fact', 'manual', $2, $3, $4, $5) RETURNING id`,
        [text, opts.sensitivity ?? "normal", `h-${text}`, createdAt, createdAt]
      )
    ).rows[0] as { id: number }
  ).id;
  if (opts.subject) await db.query("UPDATE memories SET subject_entity_id=$1 WHERE id=$2", [opts.subject, id]);
  return id;
}

const NOW = Date.parse("2026-06-15T00:00:00.000Z");
const since7d = NOW - 7 * 86400000;

describe("entityDigest", () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => { ctx = await load(); });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("returns the entity's facts created within the window, newest first", async () => {
    const { db, entitySql, digest } = ctx;
    const e = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements" });
    const recent = await insertFact(db, "closed 50 offers", "2026-06-14T00:00:00.000Z", { subject: e.id });
    const old = await insertFact(db, "old milestone", "2026-05-01T00:00:00.000Z", { subject: e.id });
    await entitySql.linkMemoryEntity(db, { memoryId: recent, entityId: e.id, role: "subject" });
    await entitySql.linkMemoryEntity(db, { memoryId: old, entityId: e.id, role: "subject" });

    const d = await digest.entityDigest(db, e.id, since7d);
    expect(d).not.toBeNull();
    expect(d!.newFacts.map((f) => f.id)).toEqual([recent]); // old one is outside the window
  });

  it("excludes sensitive facts from the digest", async () => {
    const { db, entitySql, digest } = ctx;
    const e = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul" });
    const s = await insertFact(db, "comp is 90 LPA", "2026-06-14T00:00:00.000Z", { subject: e.id, sensitivity: "sensitive" });
    await entitySql.linkMemoryEntity(db, { memoryId: s, entityId: e.id, role: "subject" });
    const d = await digest.entityDigest(db, e.id, since7d);
    expect(d!.newFacts).toHaveLength(0);
  });

  it("returns nothing for a non-founder viewer (founders mode)", async () => {
    const { db, entitySql, digest, scope } = ctx;
    delete process.env.MEMORY_ACL_MODE;
    const e = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements" });
    const f = await insertFact(db, "closed 50 offers", "2026-06-14T00:00:00.000Z", { subject: e.id });
    await entitySql.linkMemoryEntity(db, { memoryId: f, entityId: e.id, role: "subject" });
    const stranger = scope.buildViewerScope("U9", { founderUserIds: ["U1"] });
    const d = await digest.entityDigest(db, e.id, since7d, stranger);
    expect(d!.newFacts).toHaveLength(0);
  });
});

describe("orgDigest", () => {
  let ctx: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => { ctx = await load(); });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("returns recent facts org-wide, annotated with the subject entity name, capped", async () => {
    const { db, entitySql, digest } = ctx;
    const team = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements" });
    await insertFact(db, "closed 50 offers", "2026-06-14T00:00:00.000Z", { subject: team.id });
    await insertFact(db, "unrelated recent note", "2026-06-13T00:00:00.000Z");
    await insertFact(db, "ancient note", "2026-01-01T00:00:00.000Z");

    const d = await digest.orgDigest(db, since7d, undefined, 30);
    expect(d.items.map((i) => i.text)).toContain("closed 50 offers");
    expect(d.items.map((i) => i.text)).toContain("unrelated recent note");
    expect(d.items.map((i) => i.text)).not.toContain("ancient note"); // outside window
    const withSubject = d.items.find((i) => i.text === "closed 50 offers");
    expect(withSubject!.subject).toBe("Placements");
  });

  it("respects the limit", async () => {
    const { db, digest } = ctx;
    for (let i = 0; i < 5; i++) await insertFact(db, `note ${i}`, "2026-06-14T00:00:00.000Z");
    expect((await digest.orgDigest(db, since7d, undefined, 3)).items).toHaveLength(3);
  });
});
