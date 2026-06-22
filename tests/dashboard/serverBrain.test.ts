import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, () => {
    const a = server.address();
    resolve(typeof a === "object" && a ? a.port : 0);
  }));
}
const close = (s: http.Server) => new Promise<void>((r) => s.close(() => r()));
function get(port: number, p: string): Promise<{ status: number; json: () => any }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: () => JSON.parse(d) }));
    }).on("error", reject);
  });
}

describe("dashboard API — company-brain routes", () => {
  let server: http.Server;
  let port: number;
  let role: "founder" | "member" = "founder";

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
    const pool = db.getPool();
    await pool.query(`INSERT INTO entities (id, type, canonical_name, normalized_name, visibility, status, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
      (1,'person','Asha Rao','asha rao','founders','active','t','t'),
      (2,'team','Platform','platform','founders','active','t','t')`);
    await pool.query(`SELECT setval(pg_get_serial_sequence('entities','id'), 50)`);
    await pool.query(`INSERT INTO entity_edges (src_id, dst_id, relation, confidence, status, created_at, updated_at) VALUES (1,2,'member_of',0.9,'active','t','t')`);
    await pool.query(`INSERT INTO entity_profiles (entity_id, profile_md, source_fact_ids, fact_count, version, model, built_at, updated_at) VALUES (1,'# Asha','[20]',1,1,'gpt-4o','t','t')`);
    await pool.query(`INSERT INTO memories (id, text, category, entities, source_type, evidence_quote, confidence, verified, visibility, sensitivity, status, content_hash, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
      (20,'Asha owns Platform','owner','["Asha"]','meeting','x',0.8,1,'founders','normal','active','h20','2026-06-22T00:00:00.000Z','t'),
      (21,'Secret comp','fact','[]','email','y',0.7,0,'founders','sensitive','active','h21','2026-06-22T00:00:00.000Z','t')`);
    await pool.query(`SELECT setval(pg_get_serial_sequence('memories','id'), 50)`);
    await pool.query(`INSERT INTO memory_entities (memory_id, entity_id, role, confidence, created_at) VALUES (20,1,'owner',0.9,'t')`);
    await pool.query(`INSERT INTO personas (user_id, display_name, role, created_at, updated_at) VALUES ('U1','Asha Rao','founder','t','t')`);
    await pool.query(`INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at) VALUES ('U1','focus_area','placements',0.8,3,'t','t')`);
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    const { dashboardViewerScope } = await import("../../src/dashboard/brain.js");
    return createDashboardServer({ db: pool, viewer: dashboardViewerScope(role) });
  }

  beforeEach(async () => {
    vi.resetModules();
    role = "founder";
    server = await load();
    port = await listen(server);
  });
  afterEach(async () => {
    await close(server);
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  it("GET /api/entities → catalogue", async () => {
    const r = await get(port, "/api/entities");
    expect(r.status).toBe(200);
    expect(r.json().items.map((e: any) => e.canonicalName)).toContain("Asha Rao");
  });

  it("GET /api/entities/:id → dossier, 404 for unknown", async () => {
    const ok = await get(port, "/api/entities/1");
    expect(ok.status).toBe(200);
    const b = ok.json();
    expect(b.entity.canonicalName).toBe("Asha Rao");
    expect(b.relationships[0].otherName).toBe("Platform");
    expect(b.backingFacts.map((f: any) => f.id)).toContain(20);
    expect((await get(port, "/api/entities/999")).status).toBe(404);
  });

  it("GET /api/graph → nodes + edges", async () => {
    const g = (await get(port, "/api/graph")).json();
    expect(g.nodes.length).toBe(2);
    expect(g.edges[0].relation).toBe("member_of");
  });

  it("GET /api/memories → hides sensitive by default", async () => {
    const m = (await get(port, "/api/memories")).json();
    expect(m.items.map((x: any) => x.id)).toContain(20);
    expect(m.items.map((x: any) => x.id)).not.toContain(21);
  });

  it("GET /api/personas + /api/personas/:id", async () => {
    expect((await get(port, "/api/personas")).json().items.map((p: any) => p.userId)).toContain("U1");
    const d = (await get(port, "/api/personas/U1")).json();
    expect(d.traits.map((t: any) => t.value)).toContain("placements");
    expect((await get(port, "/api/personas/NOPE")).status).toBe(404);
  });

  it("enforces ACL: a non-founder viewer gets empty brain results", async () => {
    await close(server);
    role = "member";
    server = await load();
    port = await listen(server);
    expect((await get(port, "/api/entities")).json().items).toHaveLength(0);
    expect((await get(port, "/api/memories")).json().items).toHaveLength(0);
  });
});
