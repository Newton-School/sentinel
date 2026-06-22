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
  const impact = await import("../../src/dashboard/impact.js");
  return { impact, pool: db.getPool() };
}

describe("dashboard executive-impact aggregation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  it("computes month-over-month KPIs, trend, and coverage breakdowns", async () => {
    const { impact, pool } = await load();
    // now = 2026-06-22 → this month = June, last month = May, window = ~Apr 27+
    await pool.query(`INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, created_at, sources_used) VALUES
      ('U1','C1','t','Q','placements','2026-06-10T00:00:00.000Z','["metabase","memory"]'),
      ('U2','C1','t','Q','finance',   '2026-06-15T00:00:00.000Z','["memory"]'),
      ('U1','C1','t','Q','placements','2026-05-20T00:00:00.000Z',NULL)`);
    await pool.query(`INSERT INTO feedback (channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at) VALUES
      ('C1','r1','U2','+1','positive',1,'2026-06-11T00:00:00.000Z'),
      ('C1','r2','U2','-1','negative',-1,'2026-05-21T00:00:00.000Z')`);
    await pool.query(`INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, cost_usd, status, created_at) VALUES
      ('c1','T1','openai','m','reply',0.01,'ok','2026-06-10T00:00:01.000Z'),
      ('c2','T2','openai','m','reply',0.02,'ok','2026-05-20T00:00:01.000Z')`);
    await pool.query(`INSERT INTO personas (user_id, display_name, role, created_at, updated_at) VALUES
      ('U1','Alice','founder','t','t'),('U2','Bob',NULL,'t','t')`);

    const r = await impact.getImpact(pool, { now: "2026-06-22T00:00:00.000Z" });

    expect(r.current).toMatchObject({ queries: 2, users: 2, positive: 1, negative: 0 });
    expect(r.current.costUsd).toBeCloseTo(0.01, 6);
    expect(r.previous).toMatchObject({ queries: 1, users: 1, positive: 0, negative: 1 });
    expect(r.previous.costUsd).toBeCloseTo(0.02, 6);

    expect(r.categories).toEqual(
      expect.arrayContaining([{ key: "placements", count: 2 }, { key: "finance", count: 1 }])
    );
    expect(r.sources).toEqual(
      expect.arrayContaining([{ key: "memory", count: 2 }, { key: "metabase", count: 1 }])
    );
    const u1 = r.topUsers.find((u) => u.userId === "U1")!;
    expect(u1).toMatchObject({ count: 2, displayName: "Alice", role: "founder" });
    expect(r.weekly.length).toBeGreaterThanOrEqual(2);
    expect(r.weekly.reduce((s, w) => s + w.queries, 0)).toBe(3); // all 3 within the 8-week window
  });
});
