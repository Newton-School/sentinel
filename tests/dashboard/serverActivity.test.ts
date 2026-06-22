import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

function listen(s: http.Server): Promise<number> {
  return new Promise((r) => s.listen(0, () => {
    const a = s.address();
    r(typeof a === "object" && a ? a.port : 0);
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

describe("dashboard API — activity (DB-backed)", () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    vi.resetModules();
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
    await pool.query(`INSERT INTO ingest_cursors (source, cursor, updated_at) VALUES ('meet','x','2026-06-22T08:00:00.000Z')`);
    await pool.query(`INSERT INTO joined_meetings (event_id, joined_at) VALUES ('e1', 1000)`);
    await pool.query(`INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, error_kind, created_at)
      VALUES ('c1','T1','openai','m','reply','error','timeout','2026-06-22T09:00:00.000Z')`);
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    server = createDashboardServer({ db: pool });
    port = await listen(server);
  });
  afterEach(async () => {
    await close(server);
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  it("GET /api/activity → cursors, meetings, failed calls", async () => {
    const a = (await get(port, "/api/activity")).json();
    expect(a.cursors.map((c: any) => c.source)).toContain("meet");
    expect(a.meetings.map((m: any) => m.eventId)).toContain("e1");
    expect(a.failedCalls.map((f: any) => f.errorKind)).toContain("timeout");
  });
});

describe("dashboard API — /api/system readiness proxy (fakes)", () => {
  async function srv(deps: any) {
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    return createDashboardServer({ db: { query: async () => ({ rows: [] }) }, ...deps });
  }

  it("returns the bot readiness when a fetcher is provided", async () => {
    const server = await srv({ fetchReadiness: async () => ({ status: "ok", slack: "connected", mcpServers: ["Metabase"] }) });
    const port = await listen(server);
    try {
      const b = (await get(port, "/api/system")).json();
      expect(b.bot.status).toBe("ok");
      expect(b.bot.mcpServers).toEqual(["Metabase"]);
    } finally {
      await close(server);
    }
  });

  it("returns bot:null when no fetcher is configured", async () => {
    const server = await srv({});
    const port = await listen(server);
    try {
      expect((await get(port, "/api/system")).json().bot).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("returns bot:null (never errors) when the fetcher throws", async () => {
    const server = await srv({ fetchReadiness: async () => { throw new Error("unreachable"); } });
    const port = await listen(server);
    try {
      const r = await get(port, "/api/system");
      expect(r.status).toBe(200);
      expect(r.json().bot).toBeNull();
    } finally {
      await close(server);
    }
  });
});
