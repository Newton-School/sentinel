import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";

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

async function insertMemory(
  db: Pool,
  text: string,
  entities: string[],
  category = "fact"
): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  const row = (
    await db.query(
      `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
       VALUES ($1, $2, $3, 'meeting', $4, $5, $6) RETURNING id`,
      [text, category, JSON.stringify(entities), `h-${text}`, now, now]
    )
  ).rows[0] as { id: number };
  return row.id;
}

describe("backfillEntityLinks", () => {
  let db: Pool;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("links active memories that have entity names but no links yet", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    const { getMemoryEntities } = await import("../src/memory/entitySql.js");

    const m1 = await insertMemory(db, "Anjali Mehta owns onboarding", ["Anjali Mehta"], "owner");
    const m2 = await insertMemory(db, "general note, no entities", []);

    const res = await backfillEntityLinks(db, { now: new Date("2026-06-14T00:00:00.000Z") });
    expect(res.scanned).toBe(1); // m2 has empty entities, not scanned
    expect(res.linked).toBe(1);
    expect((await getMemoryEntities(db, m1)).length).toBeGreaterThan(0);
    expect(await getMemoryEntities(db, m2)).toHaveLength(0);
  });

  it("is idempotent — a second run links nothing new", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    await insertMemory(db, "Anjali Mehta owns onboarding", ["Anjali Mehta"], "owner");

    const first = await backfillEntityLinks(db);
    expect(first.linked).toBe(1);
    const second = await backfillEntityLinks(db);
    expect(second.scanned).toBe(0); // already-linked memories are skipped
    expect(second.linked).toBe(0);
  });

  it("respects the batch limit", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    await insertMemory(db, "Anjali Mehta owns A", ["Anjali Mehta"], "owner");
    await insertMemory(db, "Bhuvan Rao owns B", ["Bhuvan Rao"], "owner");
    await insertMemory(db, "Chitra Das owns C", ["Chitra Das"], "owner");

    const res = await backfillEntityLinks(db, { limit: 2 });
    expect(res.scanned).toBe(2);
  });

  it("skips non-active memories", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    const id = await insertMemory(db, "Dev Kumar owns D", ["Dev Kumar"], "owner");
    await db.query(`UPDATE memories SET status='forgotten' WHERE id = $1`, [id]);
    const res = await backfillEntityLinks(db);
    expect(res.scanned).toBe(0);
  });

  it("drains past UNLINKABLE facts via the id cursor (no infinite re-scan)", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    const { createEntity } = await import("../src/memory/entitySql.js");
    // Two "Rahul *" entities make a bare "Rahul" mention ambiguous → no link.
    await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await createEntity(db, { type: "person", canonicalName: "Rahul Verma" });
    await insertMemory(db, "Rahul shipped the feature", ["Rahul"]);

    const first = await backfillEntityLinks(db, { afterId: 0 });
    expect(first.scanned).toBe(1);
    expect(first.linked).toBe(0); // ambiguous → never links
    // The pure NOT-EXISTS drain would re-return it forever; the id cursor
    // advances past it, so the next page is empty and the drain terminates.
    const second = await backfillEntityLinks(db, { afterId: first.maxId });
    expect(second.scanned).toBe(0);
  });
});

describe("entity resolution metrics", () => {
  let db: Pool;
  beforeEach(async () => {
    ({ db } = await freshDb());
  });
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("counts matched / created / ambiguous resolution outcomes", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const { createEntity } = await import("../src/memory/entitySql.js");
    const { snapshot, reset, renderPrometheus } = await import("../src/metrics/registry.js");
    reset();

    // matched: existing exact entity
    await createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    // ambiguous: two "Rahul *"
    await createEntity(db, { type: "person", canonicalName: "Rahul Verma" });

    const mk = async (text: string, entities: string[]) =>
      (
        await db.query(
          `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
           VALUES ($1, 'fact', $2, 'manual', $3, '2026-06-14T00:00:00.000Z', '2026-06-14T00:00:00.000Z') RETURNING id`,
          [text, JSON.stringify(entities), `h-${text}`]
        )
      ).rows[0] as { id: number };

    await linkFactEntities(db, (await mk("about Rahul Sharma", ["Rahul Sharma"])).id, {
      text: "about Rahul Sharma", category: "fact", entities: ["Rahul Sharma"], sourceType: "manual",
    });
    await linkFactEntities(db, (await mk("new person", ["Anjali Mehta"])).id, {
      text: "new person", category: "fact", entities: ["Anjali Mehta"], sourceType: "manual",
    });
    await linkFactEntities(db, (await mk("ambiguous", ["Rahul"])).id, {
      text: "ambiguous", category: "fact", entities: ["Rahul"], sourceType: "manual",
    });

    const snap = snapshot();
    expect(snap.memory.entitiesResolved.matched).toBe(1);
    expect(snap.memory.entitiesResolved.created).toBe(1);
    expect(snap.memory.entitiesResolved.ambiguous).toBe(1);

    expect(renderPrometheus()).toContain('sentinel_memory_entity_resolved_total{outcome="matched"}');
  });
});
