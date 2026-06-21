import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbPool } from "../src/state/db.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const NOW_MS = Date.parse("2026-06-14T00:00:00.000Z");

async function setup() {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const entitySql = await import("../src/memory/entitySql.js");
  const consolidate = await import("../src/memory/consolidate.js");
  const client = await import("../src/llm/openaiClient.js");
  client.__resetBudgetForTests();
  return { db: getPool(), entitySql, consolidate, client };
}

async function insertMemory(db: DbPool, text: string, sensitivity = "normal"): Promise<number> {
  const now = "2026-06-10T00:00:00.000Z";
  return (
    (
      await db.query(
        `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
         VALUES ($1, 'fact', 'meeting', $2, $3, $4, $5) RETURNING id`,
        [text, sensitivity, `h-${text}`, now, now]
      )
    ).rows[0] as { id: number }
  ).id;
}

/** A fake Messages API fetch that records request bodies and returns a profile. */
function fakeFetch(profileMd: string, keyFactIds: number[] = []) {
  const bodies: any[] = [];
  const fn = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: JSON.stringify({ profile_md: profileMd, key_fact_ids: keyFactIds }) }, finish_reason: "stop" },
        ],
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return { fn, bodies };
}

describe("consolidateEntity", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  async function linkFacts(entityId: number, texts: Array<[string, string?]>) {
    for (const [text, sens] of texts) {
      const id = await insertMemory(ctx.db, text, sens ?? "normal");
      await ctx.entitySql.linkMemoryEntity(ctx.db, { memoryId: id, entityId, role: "subject" });
    }
  }

  it("builds and stores a dossier, bumping version on rebuild", async () => {
    const { db, entitySql, consolidate } = ctx;
    const e = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await linkFacts(e.id, [["owns placements"], ["closed 50 offers"], ["flagged 3 at-risk accounts"]]);

    const { fn } = fakeFetch("Rahul leads placements; 50 offers closed; 3 at-risk accounts.");
    const r1 = await consolidate.consolidateEntity(db, e.id, { apiKey: "k", fetchImpl: fn, now: () => NOW_MS });
    expect(r1.built).toBe(true);
    expect(r1.version).toBe(1);

    const prof = await entitySql.getEntityProfile(db, e.id);
    expect(prof?.profileMd).toContain("Rahul leads placements");
    expect(prof?.factCount).toBe(3);

    const r2 = await consolidate.consolidateEntity(db, e.id, { apiKey: "k", fetchImpl: fakeFetch("v2").fn, now: () => NOW_MS });
    expect(r2.version).toBe(2);
    expect(await entitySql.getProfileCursor(db, e.id)).toBe(3);
  });

  it("excludes sensitive facts from the synthesis input", async () => {
    const { db, entitySql, consolidate } = ctx;
    const e = await entitySql.createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    await linkFacts(e.id, [["public roadmap note"], ["SECRET comp is 90 LPA", "sensitive"]]);

    const { fn, bodies } = fakeFetch("profile");
    await consolidate.consolidateEntity(db, e.id, { apiKey: "k", fetchImpl: fn, now: () => NOW_MS });

    const userContent = bodies[0].messages[1].content as string; // [0] system, [1] user
    expect(userContent).toContain("public roadmap note");
    expect(userContent).not.toContain("SECRET comp");
    // The cursor still tracks the TOTAL active fact count (incl. sensitive)
    // so new sensitive facts still trigger eventual rebuilds.
    expect(await entitySql.getProfileCursor(db, e.id)).toBe(2);
  });

  it("uses Sonnet when deps.model='sonnet', Haiku otherwise", async () => {
    const { db, entitySql, consolidate, client } = ctx;
    const e = await entitySql.createEntity(db, { type: "person", canonicalName: "X Y" });
    await linkFacts(e.id, [["a fact"]]);
    const { fn, bodies } = fakeFetch("p");
    await consolidate.consolidateEntity(db, e.id, { apiKey: "k", fetchImpl: fn, now: () => NOW_MS, model: "sonnet" });
    expect(bodies[0].model).toBe(client.OPENAI_CONSOLIDATION_MODEL);
  });

  it("returns built:false (leaves no profile) when the LLM call fails", async () => {
    const { db, entitySql, consolidate } = ctx;
    const e = await entitySql.createEntity(db, { type: "person", canonicalName: "Z" });
    await linkFacts(e.id, [["a fact"]]);
    const failing = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const r = await consolidate.consolidateEntity(db, e.id, { apiKey: "k", fetchImpl: failing, now: () => NOW_MS });
    expect(r.built).toBe(false);
    expect(await entitySql.getEntityProfile(db, e.id)).toBeNull();
  });
});

describe("selectEntitiesDueForConsolidation + runConsolidation", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  async function entityWithFacts(name: string, n: number): Promise<number> {
    const e = await ctx.entitySql.createEntity(ctx.db, { type: "person", canonicalName: name });
    for (let i = 0; i < n; i++) {
      const id = await insertMemory(ctx.db, `${name} fact ${i}`);
      await ctx.entitySql.linkMemoryEntity(ctx.db, { memoryId: id, entityId: e.id, role: "subject" });
    }
    return e.id;
  }

  it("marks a never-built entity with enough facts as due, and a sparse one as not", async () => {
    const { db, consolidate } = ctx;
    const big = await entityWithFacts("Has Three", 3);
    await entityWithFacts("Has One", 1); // below MIN_FACTS_FOR_PROFILE
    const due = await consolidate.selectEntitiesDueForConsolidation(db, NOW_MS, 10);
    expect(due).toContain(big);
    expect(due).toHaveLength(1);
  });

  it("does not re-consolidate until enough new facts accumulate", async () => {
    const { db, entitySql, consolidate } = ctx;
    const id = await entityWithFacts("Settled", 3);
    // Simulate a prior consolidation at fact_count=3.
    await entitySql.upsertEntityProfile(db, { entityId: id, profileMd: "p", sourceFactIds: [], factCount: 3, model: "haiku", now: new Date(NOW_MS) });
    expect(await consolidate.selectEntitiesDueForConsolidation(db, NOW_MS, 10)).toHaveLength(0);

    // Add fewer than the delta → still not due.
    const m = await insertMemory(db, "one more fact");
    await entitySql.linkMemoryEntity(db, { memoryId: m, entityId: id, role: "mention" });
    expect(await consolidate.selectEntitiesDueForConsolidation(db, NOW_MS, 10)).toHaveLength(0);
  });

  it("runConsolidation is bounded by MAX_CONSOLIDATIONS_PER_TICK", async () => {
    const { db, consolidate } = ctx;
    for (let i = 0; i < 5; i++) await entityWithFacts(`Team ${i}`, 3);
    const { fn } = fakeFetch("profile");
    const res = await consolidate.runConsolidation(db, { apiKey: "k", fetchImpl: fn, now: () => NOW_MS });
    expect(res.built).toBe(consolidate.MAX_CONSOLIDATIONS_PER_TICK);
  });
});
