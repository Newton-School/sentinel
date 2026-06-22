import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/** Load the dashboard query layer wired to this worker's Postgres test DB. */
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
  const q = await import("../../src/dashboard/queries.js");
  return { db, q, pool: db.getPool() };
}

type Db = Awaited<ReturnType<typeof load>>["db"];

async function seed(pool: ReturnType<Db["getPool"]>) {
  await pool.query(
    `INSERT INTO personas (user_id, display_name, role, created_at, updated_at) VALUES
       ('U1','Alice','founder','t','t'), ('U2','Bob',NULL,'t','t')`
  );
  // Three bot replies, oldest → newest.
  await pool.query(
    `INSERT INTO bot_replies (channel_id, reply_ts, trace_id, user_id, question, answer, created_at) VALUES
       ('C1','r1','T1','U1','Q1','A1','2026-06-20T10:00:00.000Z'),
       ('C1','r2','T2','U2','Q2','A2','2026-06-21T10:00:00.000Z'),
       ('C1','r3','T3','U1','Q3','A3','2026-06-22T10:00:00.000Z')`
  );
  // r1 got a 👎, r3 got a 👍, r2 got nothing.
  await pool.query(
    `INSERT INTO feedback (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at) VALUES
       ('T1','C1','r1','U2','-1','negative',-1,'2026-06-20T11:00:00.000Z'),
       ('T3','C1','r3','U2','+1','positive', 1,'2026-06-22T11:00:00.000Z')`
  );
  // T1 fan-out: a reply call + an extract call. T2: a single errored reply call.
  await pool.query(
    `INSERT INTO llm_calls
       (call_id, trace_id, provider, model, operation, input_tokens, output_tokens, cost_usd, latency_ms, status, error_kind, num_turns, user_id, prompt_version, created_at) VALUES
       ('c1','T1','openai','gpt-5.4-mini','reply',  100,50,0.01, 2000,'ok',  NULL,3,'U1','system@1.0.0+abc','2026-06-20T10:00:01.000Z'),
       ('c2','T1','openai','gpt-4o-mini', 'extract',200,20,0.002,500, 'ok',  NULL,NULL,'U1',NULL,             '2026-06-20T10:00:03.000Z'),
       ('c3','T2','openai','gpt-5.4-mini','reply',  120,0, 0.02, 9000,'error','timeout',2,'U2','system@1.0.0+abc','2026-06-21T10:00:05.000Z')`
  );
  await pool.query(
    `INSERT INTO query_log (user_id, channel_id, thread_ts, query_text, category, created_at, response_duration_ms, sources_used) VALUES
       ('U1','C1','r1','Q1','placements','2026-06-20T10:00:00.000Z',2000,'["metabase"]'),
       ('U2','C1','r2','Q2','finance',   '2026-06-21T10:00:00.000Z',NULL,NULL),
       ('U1','C1','r3','Q3','general',   '2026-06-22T10:00:00.000Z',NULL,NULL)`
  );
}

describe("dashboard query layer", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    const { closeDb } = await import("../../src/state/db.js");
    await closeDb();
  });

  describe("listConversations", () => {
    it("returns replies newest-first with display name, sentiment badge and a drillable trace id", async () => {
      const { q, pool } = await load();
      await seed(pool);
      const rows = await q.listConversations(pool, { limit: 10 });
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ traceId: "T3", displayName: "Alice", sentiment: "positive", question: "Q3" });
      const t1 = rows.find((r) => r.traceId === "T1")!;
      expect(t1.sentiment).toBe("negative");
      const t2 = rows.find((r) => r.traceId === "T2")!;
      expect(t2.sentiment).toBeNull();
      expect(t2.displayName).toBe("Bob");
    });

    it("filters by user and by sentiment, and clamps the limit", async () => {
      const { q, pool } = await load();
      await seed(pool);
      expect(await q.listConversations(pool, { userId: "U1" })).toHaveLength(2);
      const neg = await q.listConversations(pool, { sentiment: "negative" });
      expect(neg).toHaveLength(1);
      expect(neg[0].traceId).toBe("T1");
      expect(await q.listConversations(pool, { limit: 1 })).toHaveLength(1);
      // A wildly oversized limit is capped, not honoured verbatim (no error).
      expect(await q.listConversations(pool, { limit: 100000 })).toHaveLength(3);
    });
  });

  describe("getTrace", () => {
    it("reconstructs the reply header, the ordered call timeline, feedback and totals", async () => {
      const { q, pool } = await load();
      await seed(pool);
      const trace = await q.getTrace(pool, "T1");
      expect(trace).not.toBeNull();
      expect(trace!.reply).toMatchObject({ question: "Q1", answer: "A1", channelId: "C1", replyTs: "r1" });
      expect(trace!.calls.map((c) => c.operation)).toEqual(["reply", "extract"]);
      expect(trace!.totals.costUsd).toBeCloseTo(0.012, 6);
      expect(trace!.totals.inputTokens).toBe(300);
      expect(trace!.totals.outputTokens).toBe(70);
      expect(trace!.totals.numTurns).toBe(3);
      expect(trace!.totals.promptVersion).toBe("system@1.0.0+abc");
      expect(trace!.feedback).toHaveLength(1);
      expect(trace!.feedback[0].sentiment).toBe("negative");
    });

    it("returns null for an unknown trace id", async () => {
      const { q, pool } = await load();
      await seed(pool);
      expect(await q.getTrace(pool, "NOPE")).toBeNull();
    });
  });

  describe("listNegativeFeedback", () => {
    it("returns only 👎'd replies, enriched with Q&A and trace cost/model/prompt version", async () => {
      const { q, pool } = await load();
      await seed(pool);
      const rows = await q.listNegativeFeedback(pool, { limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ traceId: "T1", question: "Q1", answer: "A1", model: "gpt-5.4-mini", promptVersion: "system@1.0.0+abc" });
      expect(rows[0].costUsd).toBeCloseTo(0.012, 6);
    });
  });

  describe("getSummary", () => {
    it("counts queries, distinct users, feedback and cost within the window", async () => {
      const { q, pool } = await load();
      await seed(pool);
      const all = await q.getSummary(pool, {});
      expect(all.totalQueries).toBe(3);
      expect(all.distinctUsers).toBe(2);
      expect(all.positiveCount).toBe(1);
      expect(all.negativeCount).toBe(1);
      expect(all.costUsd).toBeCloseTo(0.032, 6);

      const recent = await q.getSummary(pool, { since: "2026-06-21T00:00:00.000Z" });
      expect(recent.totalQueries).toBe(2); // Q2, Q3
      expect(recent.costUsd).toBeCloseTo(0.02, 6); // only T2's reply call
      expect(recent.positiveCount).toBe(1);
      expect(recent.negativeCount).toBe(0);
    });
  });

  describe("slack permalinks", () => {
    it("builds a permalink only when a workspace is configured", async () => {
      const { q, pool } = await load();
      await seed(pool);
      const url = (ts: string) => `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`;

      const withWs = await q.listConversations(pool, { slackWorkspace: "acme" });
      expect(withWs[0].slackUrl).toBe(url(withWs[0].replyTs));
      expect((await q.listConversations(pool, {}))[0].slackUrl).toBeNull();

      const trace = await q.getTrace(pool, "T1", { slackWorkspace: "acme" });
      expect(trace!.reply!.slackUrl).toBe(url(trace!.reply!.replyTs));
      expect((await q.getTrace(pool, "T1"))!.reply!.slackUrl).toBeNull();

      const neg = await q.listNegativeFeedback(pool, { slackWorkspace: "acme" });
      expect(neg[0].slackUrl).toBe(url(neg[0].replyTs));
    });

    it("slackPermalink strips the dot from the ts and is null without a workspace", async () => {
      const { q } = await load();
      expect(q.slackPermalink("acme", "C9", "1719050400.123456")).toBe("https://acme.slack.com/archives/C9/p1719050400123456");
      expect(q.slackPermalink(undefined, "C9", "1.2")).toBeNull();
    });
  });
});
