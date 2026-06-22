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
  const activity = await import("../../src/dashboard/activity.js");
  return { activity, pool: db.getPool() };
}

describe("dashboard activity queries", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  it("returns ingest cursors, recent meet joins, and failed calls with the question", async () => {
    const { activity, pool } = await load();
    await pool.query(`INSERT INTO ingest_cursors (source, cursor, updated_at) VALUES
      ('meet','2026-06-22T08:00:00.000Z','2026-06-22T08:00:00.000Z'),
      ('gmail','2026-06-21T08:00:00.000Z','2026-06-21T08:00:00.000Z')`);
    await pool.query(`INSERT INTO joined_meetings (event_id, joined_at) VALUES ('e1', 1000), ('e2', 2000)`);
    await pool.query(`INSERT INTO bot_replies (channel_id, reply_ts, trace_id, user_id, question, answer, created_at)
      VALUES ('C1','r1','T1','U1','Why did this fail?','...','2026-06-22T09:00:00.000Z')`);
    await pool.query(`INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, error_kind, latency_ms, user_id, created_at) VALUES
      ('c1','T1','openai','gpt-5.4-mini','reply','error','timeout',9000,'U1','2026-06-22T09:00:05.000Z'),
      ('c2','T2','openai','gpt-4o-mini','extract','ok',NULL,500,'U1','2026-06-22T09:00:06.000Z')`);

    const a = await activity.getActivity(pool, { limit: 10 });
    expect(a.cursors.map((c) => c.source)).toEqual(["gmail", "meet"]);
    expect(a.meetings.map((m) => m.eventId)).toEqual(["e2", "e1"]); // newest first
    expect(a.meetings[0].joinedAt).toBe(2000);
    expect(a.failedCalls).toHaveLength(1); // only the errored call
    expect(a.failedCalls[0]).toMatchObject({ callId: "c1", errorKind: "timeout", question: "Why did this fail?" });
  });

  it("does not duplicate a failed call when its trace has multiple bot replies", async () => {
    const { activity, pool } = await load();
    await pool.query(`INSERT INTO bot_replies (channel_id, reply_ts, trace_id, question, answer, created_at) VALUES
      ('C1','r1','T1','Q','A','2026-06-22T09:00:00.000Z'),
      ('C1','r2','T1','Q again','A2','2026-06-22T09:01:00.000Z')`);
    await pool.query(`INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, error_kind, created_at)
      VALUES ('c1','T1','openai','m','reply','error','run','2026-06-22T09:02:00.000Z')`);
    const a = await activity.getActivity(pool);
    expect(a.failedCalls).toHaveLength(1);
  });
});
