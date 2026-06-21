import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/** Load feedback store + collaborators wired to this worker's Postgres test DB. */
async function load() {
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const db = await import("../src/state/db.js");
  await db.initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const store = await import("../src/feedback/store.js");
  const registry = await import("../src/metrics/registry.js");
  return { db, store, registry };
}

describe("feedback tables + store", () => {
  beforeEach(() => vi.resetModules());

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("creates bot_replies and feedback tables with the expected columns", async () => {
    const { db } = await load();
    const cols = async (t: string) =>
      (await db.getPool().query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [t]
      )).rows.map((r: { column_name: string }) => r.column_name);
    const botReplyCols = await cols("bot_replies");
    for (const c of ["channel_id", "reply_ts", "trace_id", "user_id", "question", "answer", "created_at"]) {
      expect(botReplyCols).toContain(c);
    }
    const feedbackCols = await cols("feedback");
    for (const c of ["trace_id", "channel_id", "reply_ts", "reactor_user_id", "reaction", "sentiment", "score", "created_at"]) {
      expect(feedbackCols).toContain(c);
    }
  });

  it("records a 👎 on a tracked bot reply, resolving the trace id, and counts the metric", async () => {
    const { db, store, registry } = await load();
    registry.reset();
    await store.recordReply({ channelId: "C1", replyTs: "111.1", traceId: "T1", userId: "U1", question: "Q?", answer: "A." });

    const ok = await store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "-1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    expect(ok).toBe(true);

    const row = (await db.getPool().query("SELECT trace_id, sentiment, score FROM feedback")).rows[0] as Record<string, unknown>;
    expect(row.trace_id).toBe("T1");
    expect(row.sentiment).toBe("negative");
    expect(row.score).toBe(-1);
    expect(registry.snapshot().feedback.negative).toBe(1);
  });

  it("ignores reactions on messages that are not tracked bot replies", async () => {
    const { db, store } = await load();
    const ok = await store.recordFeedback({ channelId: "C1", replyTs: "999.9", reactorUserId: "U2", reaction: "+1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    expect(ok).toBe(false);
    expect(((await db.getPool().query("SELECT COUNT(*)::int AS c FROM feedback")).rows[0] as { c: number }).c).toBe(0);
  });

  it("ignores non-feedback emoji and de-duplicates repeated reactions", async () => {
    const { db, store, registry } = await load();
    registry.reset();
    await store.recordReply({ channelId: "C1", replyTs: "111.1", traceId: "T1" });

    expect(await store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "eyes", addedAtIso: "t" })).toBe(false);
    expect(await store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "+1", addedAtIso: "t" })).toBe(true);
    // Re-adding the same reaction is deduped (no new row, no extra metric).
    expect(await store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "+1", addedAtIso: "t" })).toBe(false);

    expect(((await db.getPool().query("SELECT COUNT(*)::int AS c FROM feedback")).rows[0] as { c: number }).c).toBe(1);
    expect(registry.snapshot().feedback.positive).toBe(1);
  });

  it("harvestNegativeFeedback returns question/answer pairs for 👎'd replies", async () => {
    const { store } = await load();
    await store.recordReply({ channelId: "C1", replyTs: "1.1", traceId: "T1", question: "Who owns pricing?", answer: "Unclear." });
    await store.recordReply({ channelId: "C1", replyTs: "2.2", traceId: "T2", question: "MRR?", answer: "₹50L." });
    await store.recordFeedback({ channelId: "C1", replyTs: "1.1", reactorUserId: "U2", reaction: "-1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    await store.recordFeedback({ channelId: "C1", replyTs: "2.2", reactorUserId: "U2", reaction: "+1", addedAtIso: "2026-06-28T00:00:00.000Z" });

    const harvested = await store.harvestNegativeFeedback(10);
    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject({ question: "Who owns pricing?", answer: "Unclear." });
  });

  it("recordButtonFeedback records a vote with explicit sentiment, resolving the trace", async () => {
    const { db, store, registry } = await load();
    registry.reset();
    await store.recordReply({ channelId: "C1", replyTs: "5.5", traceId: "TB", question: "Q", answer: "A" });

    const ok = await store.recordButtonFeedback({ channelId: "C1", replyTs: "5.5", reactorUserId: "U2", sentiment: "negative", addedAtIso: "2026-06-28T00:00:00.000Z" });
    expect(ok).toBe(true);

    const row = (await db.getPool().query("SELECT trace_id, reaction, sentiment, score FROM feedback")).rows[0] as Record<string, unknown>;
    expect(row.trace_id).toBe("TB");
    expect(row.reaction).toBe("button");
    expect(row.sentiment).toBe("negative");
    expect(row.score).toBe(-1);
    expect(registry.snapshot().feedback.negative).toBe(1);
  });

  it("a user's latest button vote wins (one row per user+reply), and harvests when negative", async () => {
    const { db, store } = await load();
    await store.recordReply({ channelId: "C1", replyTs: "5.5", traceId: "TB", question: "Who owns pricing?", answer: "Unclear." });

    await store.recordButtonFeedback({ channelId: "C1", replyTs: "5.5", reactorUserId: "U2", sentiment: "positive", addedAtIso: "t1" });
    await store.recordButtonFeedback({ channelId: "C1", replyTs: "5.5", reactorUserId: "U2", sentiment: "negative", addedAtIso: "t2" });

    // Switching the vote replaces the row rather than adding a second.
    expect(((await db.getPool().query("SELECT COUNT(*)::int AS c FROM feedback")).rows[0] as { c: number }).c).toBe(1);
    const row = (await db.getPool().query("SELECT sentiment FROM feedback")).rows[0] as { sentiment: string };
    expect(row.sentiment).toBe("negative");
    // Now harvestable as a 👎'd case.
    expect(await store.harvestNegativeFeedback(10)).toHaveLength(1);
  });

  it("recordButtonFeedback ignores an untracked reply", async () => {
    const { store } = await load();
    expect(await store.recordButtonFeedback({ channelId: "C1", replyTs: "nope", reactorUserId: "U2", sentiment: "positive", addedAtIso: "t" })).toBe(false);
  });

  it("pruneFeedback + pruneBotReplies drop rows older than their windows", async () => {
    const { db, store } = await load();
    const DAY = 86_400_000;
    const NOW = Date.parse("2026-06-28T00:00:00.000Z");
    await store.recordReply({ channelId: "C1", replyTs: "1.1", traceId: "T1" });
    await db.getPool().query("UPDATE bot_replies SET created_at=$1 WHERE reply_ts='1.1'", [new Date(NOW - 200 * DAY).toISOString()]);
    await db.getPool().query(
      "INSERT INTO feedback (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at) VALUES ('T1','C1','1.1','U2','-1','negative',-1,$1)",
      [new Date(NOW - 200 * DAY).toISOString()]
    );

    expect(await db.pruneFeedback(180, NOW)).toBe(1);
    expect(await db.pruneBotReplies(90, NOW)).toBe(1);
  });
});
