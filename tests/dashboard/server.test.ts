import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// ── tiny HTTP client over an ephemeral port ────────────────────────────────
function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
function get(port: number, p: string): Promise<{ status: number; contentType?: string; text: string; json: () => unknown }> {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${port}${p}`, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"],
          text: data,
          json: () => JSON.parse(data),
        })
      );
    }).on("error", reject);
  });
}

// ── DB-backed integration: real router → queries → Postgres → JSON ─────────
describe("dashboard API server (DB-backed)", () => {
  let server: http.Server;
  let port: number;

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
    await pool.query(
      `INSERT INTO personas (user_id, display_name, role, created_at, updated_at) VALUES ('U1','Alice','founder','t','t')`
    );
    await pool.query(
      `INSERT INTO bot_replies (channel_id, reply_ts, trace_id, user_id, question, answer, created_at)
       VALUES ('C1','r1','T1','U1','Q1','A1','2026-06-20T10:00:00.000Z')`
    );
    await pool.query(
      `INSERT INTO feedback (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at)
       VALUES ('T1','C1','r1','U2','-1','negative',-1,'2026-06-20T11:00:00.000Z')`
    );
    await pool.query(
      `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, input_tokens, output_tokens, cost_usd, latency_ms, status, num_turns, user_id, prompt_version, created_at)
       VALUES ('c1','T1','openai','gpt-5.4-mini','reply',100,50,0.01,2000,'ok',3,'U1','system@1.0.0+abc','2026-06-20T10:00:01.000Z')`
    );
    await pool.query(
      `INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, created_at) VALUES ('U1','C1','r1','Q1','placements','2026-06-20T10:00:00.000Z')`
    );
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    return createDashboardServer({ db: pool });
  }

  beforeEach(async () => {
    vi.resetModules();
    server = await load();
    port = await listen(server);
  });
  afterEach(async () => {
    await close(server);
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  it("GET /api/health → 200 ok", async () => {
    const res = await get(port, "/api/health");
    expect(res.status).toBe(200);
    expect((res.json() as { status: string }).status).toBe("ok");
  });

  it("GET /api/summary → counts", async () => {
    const res = await get(port, "/api/summary");
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.totalQueries).toBe(1);
    expect(body.distinctUsers).toBe(1);
    expect(body.negativeCount).toBe(1);
    expect(body.costUsd).toBeCloseTo(0.01, 6);
  });

  it("GET /api/conversations → items, drillable + sentiment badge", async () => {
    const res = await get(port, "/api/conversations");
    expect(res.status).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ traceId: "T1", displayName: "Alice", sentiment: "negative" });
  });

  it("GET /api/conversations honours filters", async () => {
    expect(((await get(port, "/api/conversations?userId=U1")).json() as { items: unknown[] }).items).toHaveLength(1);
    expect(((await get(port, "/api/conversations?userId=NOPE")).json() as { items: unknown[] }).items).toHaveLength(0);
    expect(((await get(port, "/api/conversations?sentiment=negative")).json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it("GET /api/conversations rejects an invalid limit with 400", async () => {
    const res = await get(port, "/api/conversations?limit=abc");
    expect(res.status).toBe(400);
  });

  it("GET /api/traces/:id → reconstruction, and 404 for unknown", async () => {
    const ok = await get(port, "/api/traces/T1");
    expect(ok.status).toBe(200);
    const body = ok.json() as Record<string, any>;
    expect(body.reply.question).toBe("Q1");
    expect(body.calls).toHaveLength(1);
    expect(body.totals.numTurns).toBe(3);

    const miss = await get(port, "/api/traces/NOPE");
    expect(miss.status).toBe(404);
  });

  it("GET /api/feedback?sentiment=negative → enriched queue", async () => {
    const res = await get(port, "/api/feedback?sentiment=negative");
    expect(res.status).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ traceId: "T1", question: "Q1", model: "gpt-5.4-mini" });
  });

  it("returns 404 JSON for an unknown /api route", async () => {
    const res = await get(port, "/api/nope");
    expect(res.status).toBe(404);
    expect((res.json() as { error: string }).error).toBeTruthy();
  });
});

// ── routing/serving with injected fake deps (no DB) ────────────────────────
describe("dashboard API server (fakes)", () => {
  it("returns 500 JSON when a query throws", async () => {
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    const db = { query: async () => { throw new Error("boom"); } };
    const server = createDashboardServer({ db: db as never });
    const port = await listen(server);
    try {
      const res = await get(port, "/api/summary");
      expect(res.status).toBe(500);
      expect((res.json() as { error: string }).error).toBeTruthy();
    } finally {
      await close(server);
    }
  });

  it("serves the SPA static assets and falls back to index.html for client routes", async () => {
    const { createDashboardServer } = await import("../../src/dashboard/server.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-static-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Sentinel</title>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('hi')");
    const db = { query: async () => ({ rows: [] }) };
    const server = createDashboardServer({ db: db as never, staticDir: dir });
    const port = await listen(server);
    try {
      const index = await get(port, "/");
      expect(index.status).toBe(200);
      expect(index.text).toContain("Sentinel");

      const asset = await get(port, "/assets/app.js");
      expect(asset.status).toBe(200);
      expect(asset.text).toContain("console.log");
      expect(asset.contentType).toContain("javascript");

      // Unknown extension-less path → SPA fallback (index.html), not 404.
      const route = await get(port, "/conversations/T1");
      expect(route.status).toBe(200);
      expect(route.text).toContain("Sentinel");

      // A missing asset (has a file extension) must 404, not fall back to HTML.
      expect((await get(port, "/assets/missing.js")).status).toBe(404);

      // /api still 404s (not swallowed by the SPA fallback).
      expect((await get(port, "/api/nope")).status).toBe(404);
    } finally {
      await close(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
