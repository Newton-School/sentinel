import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const db = await import("../../src/state/db.js");
  await db.initDb();
  const { resetTestDb } = await import("../helpers/pgTest.js");
  await resetTestDb();
  const brain = await import("../../src/dashboard/brain.js");
  return { db, brain, pool: db.getPool() };
}

type Pool = Awaited<ReturnType<typeof load>>["pool"];

async function seed(pool: Pool) {
  // Entities: a person, a team, a project (all founders-visibility by default).
  await pool.query(`INSERT INTO entities (id, type, canonical_name, normalized_name, aliases, visibility, status, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
    (1,'person','Asha Rao','asha rao','["Asha"]','founders','active','t','t'),
    (2,'team','Platform','platform',NULL,'founders','active','t','t'),
    (3,'project','Atlas','atlas',NULL,'founders','active','t','t'),
    (4,'person','Ghost','ghost',NULL,'founders','forgotten','t','t')`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('entities','id'), 100)`);
  await pool.query(`INSERT INTO entity_edges (src_id, dst_id, relation, confidence, status, created_at, updated_at) VALUES
    (1,2,'member_of',0.9,'active','t','t'),
    (1,3,'works_on',0.8,'active','t','t')`);
  await pool.query(`INSERT INTO entity_profiles (entity_id, profile_md, source_fact_ids, fact_count, version, model, built_at, updated_at) VALUES
    (1,'# Asha Rao\nLeads Platform.','[10]',3,1,'gpt-4o','t','t')`);
  await pool.query(`INSERT INTO memories (id, text, category, entities, source_type, source_label, evidence_quote, confidence, verified, visibility, sensitivity, status, content_hash, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
    (10,'Asha owns Platform roadmap','owner','["Asha","Platform"]','meeting','Mtg A','asha owns',0.8,1,'founders','normal','active','h10','2026-06-22T00:00:00.000Z','t'),
    (11,'Comp band for Platform leads is X','fact','["Platform"]','email','Mail B','band x',0.7,0,'founders','sensitive','active','h11','2026-06-21T00:00:00.000Z','t'),
    (12,'Superseded note','fact','[]','manual',NULL,NULL,0.5,0,'founders','normal','superseded','h12','2026-06-20T00:00:00.000Z','t')`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('memories','id'), 100)`);
  await pool.query(`INSERT INTO memory_entities (memory_id, entity_id, role, confidence, created_at) VALUES
    (10,1,'owner',0.9,'t'),(11,2,'about',0.8,'t')`);
  await pool.query(`INSERT INTO personas (user_id, display_name, role, created_at, updated_at) VALUES ('U1','Asha Rao','founder','t','2026-06-22T00:00:00.000Z')`);
  await pool.query(`INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at) VALUES
    ('U1','focus_area','placements',0.8,5,'t','t')`);
}

describe("dashboard company-brain query layer", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  describe("viewer scope + ACL (founders mode)", () => {
    it("a founder viewer sees rows; a non-founder sees nothing", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const founder = brain.dashboardViewerScope("founder");
      const member = brain.dashboardViewerScope("member");
      expect((await brain.listEntities(pool, founder)).length).toBeGreaterThan(0);
      expect(await brain.listEntities(pool, member)).toHaveLength(0);
      expect(await brain.listMemories(pool, member)).toHaveLength(0);
    });
  });

  describe("listEntities", () => {
    it("returns active entities with fact counts, excludes forgotten, filters by type + search", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const v = brain.dashboardViewerScope("founder");
      const all = await brain.listEntities(pool, v);
      expect(all.map((e) => e.canonicalName)).toContain("Asha Rao");
      expect(all.map((e) => e.canonicalName)).not.toContain("Ghost"); // forgotten
      const asha = all.find((e) => e.canonicalName === "Asha Rao")!;
      expect(asha.factCount).toBe(3);
      expect((await brain.listEntities(pool, v, { type: "team" })).every((e) => e.type === "team")).toBe(true);
      expect((await brain.listEntities(pool, v, { search: "asha" })).map((e) => e.canonicalName)).toEqual(["Asha Rao"]);
    });
  });

  describe("getGraph", () => {
    it("returns visible nodes + the edges among them", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const g = await brain.getGraph(pool, brain.dashboardViewerScope("founder"));
      expect(g.nodes.length).toBe(3); // Asha, Platform, Atlas (not forgotten Ghost)
      expect(g.edges.length).toBe(2);
      expect(g.edges.map((e) => e.relation).sort()).toEqual(["member_of", "works_on"]);
    });
  });

  describe("getEntityDetail", () => {
    it("returns profile, relationships, and ACL-filtered backing facts", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const v = brain.dashboardViewerScope("founder");
      const d = (await brain.getEntityDetail(pool, 1, v))!;
      expect(d.entity.canonicalName).toBe("Asha Rao");
      expect(d.profileMd).toContain("Asha Rao");
      expect(d.relationships.map((r) => r.relation).sort()).toEqual(["member_of", "works_on"]);
      expect(d.relationships.find((r) => r.relation === "member_of")!.otherName).toBe("Platform");
      // The owner fact (memory 10) backs Asha; it's normal-sensitivity → shown.
      expect(d.backingFacts.map((f) => f.id)).toContain(10);
    });

    it("returns null for unknown / forgotten entities", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const v = brain.dashboardViewerScope("founder");
      expect(await brain.getEntityDetail(pool, 999, v)).toBeNull();
      expect(await brain.getEntityDetail(pool, 4, v)).toBeNull(); // forgotten
    });
  });

  describe("listMemories", () => {
    it("returns active facts, excludes superseded, filters, and hides sensitive by default", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      const v = brain.dashboardViewerScope("founder");
      const def = await brain.listMemories(pool, v);
      expect(def.map((m) => m.id)).toContain(10);
      expect(def.map((m) => m.id)).not.toContain(12); // superseded
      expect(def.map((m) => m.id)).not.toContain(11); // sensitive hidden by default
      const withSensitive = await brain.listMemories(pool, v, { showSensitive: true });
      expect(withSensitive.map((m) => m.id)).toContain(11);
      expect((await brain.listMemories(pool, v, { category: "owner" })).every((m) => m.category === "owner")).toBe(true);
      expect((await brain.listMemories(pool, v, { since: "2026-06-22T00:00:00.000Z" })).map((m) => m.id)).toEqual([10]);
    });
  });

  describe("personas", () => {
    it("lists personas and returns traits for one", async () => {
      const { brain, pool } = await load();
      await seed(pool);
      expect((await brain.listPersonas(pool)).map((p) => p.userId)).toContain("U1");
      const p = (await brain.getPersona(pool, "U1"))!;
      expect(p.displayName).toBe("Asha Rao");
      expect(p.traits.map((t) => t.value)).toContain("placements");
    });
  });
});
