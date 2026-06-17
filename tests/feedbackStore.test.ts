import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  vi.resetModules();
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
  vi.doMock("../src/config.js", () => ({ config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" } }));
  const db = await import("../src/state/db.js");
  const store = await import("../src/feedback/store.js");
  const registry = await import("../src/metrics/registry.js");
  return { db, store, registry };
}

describe("feedback tables + store", () => {
  beforeEach(() => vi.resetModules());

  it("creates bot_replies and feedback tables with the expected columns", async () => {
    const { db } = await load();
    const cols = (t: string) => (db.getDb().pragma(`table_info(${t})`) as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["channel_id", "reply_ts", "trace_id", "user_id", "question", "answer", "created_at"]) {
      expect(cols("bot_replies")).toContain(c);
    }
    for (const c of ["trace_id", "channel_id", "reply_ts", "reactor_user_id", "reaction", "sentiment", "score", "created_at"]) {
      expect(cols("feedback")).toContain(c);
    }
    db.closeDb();
  });

  it("records a 👎 on a tracked bot reply, resolving the trace id, and counts the metric", async () => {
    const { db, store, registry } = await load();
    db.getDb();
    registry.reset();
    store.recordReply({ channelId: "C1", replyTs: "111.1", traceId: "T1", userId: "U1", question: "Q?", answer: "A." });

    const ok = store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "-1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    expect(ok).toBe(true);

    const row = db.getDb().prepare("SELECT trace_id, sentiment, score FROM feedback").get() as Record<string, unknown>;
    expect(row.trace_id).toBe("T1");
    expect(row.sentiment).toBe("negative");
    expect(row.score).toBe(-1);
    expect(registry.snapshot().feedback.negative).toBe(1);
    db.closeDb();
  });

  it("ignores reactions on messages that are not tracked bot replies", async () => {
    const { db, store } = await load();
    db.getDb();
    const ok = store.recordFeedback({ channelId: "C1", replyTs: "999.9", reactorUserId: "U2", reaction: "+1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    expect(ok).toBe(false);
    expect((db.getDb().prepare("SELECT COUNT(*) AS c FROM feedback").get() as { c: number }).c).toBe(0);
    db.closeDb();
  });

  it("ignores non-feedback emoji and de-duplicates repeated reactions", async () => {
    const { db, store, registry } = await load();
    db.getDb();
    registry.reset();
    store.recordReply({ channelId: "C1", replyTs: "111.1", traceId: "T1" });

    expect(store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "eyes", addedAtIso: "t" })).toBe(false);
    expect(store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "+1", addedAtIso: "t" })).toBe(true);
    // Re-adding the same reaction is deduped (no new row, no extra metric).
    expect(store.recordFeedback({ channelId: "C1", replyTs: "111.1", reactorUserId: "U2", reaction: "+1", addedAtIso: "t" })).toBe(false);

    expect((db.getDb().prepare("SELECT COUNT(*) AS c FROM feedback").get() as { c: number }).c).toBe(1);
    expect(registry.snapshot().feedback.positive).toBe(1);
    db.closeDb();
  });

  it("harvestNegativeFeedback returns question/answer pairs for 👎'd replies", async () => {
    const { db, store } = await load();
    db.getDb();
    store.recordReply({ channelId: "C1", replyTs: "1.1", traceId: "T1", question: "Who owns pricing?", answer: "Unclear." });
    store.recordReply({ channelId: "C1", replyTs: "2.2", traceId: "T2", question: "MRR?", answer: "₹50L." });
    store.recordFeedback({ channelId: "C1", replyTs: "1.1", reactorUserId: "U2", reaction: "-1", addedAtIso: "2026-06-28T00:00:00.000Z" });
    store.recordFeedback({ channelId: "C1", replyTs: "2.2", reactorUserId: "U2", reaction: "+1", addedAtIso: "2026-06-28T00:00:00.000Z" });

    const harvested = store.harvestNegativeFeedback(10);
    expect(harvested).toHaveLength(1);
    expect(harvested[0]).toMatchObject({ question: "Who owns pricing?", answer: "Unclear." });
    db.closeDb();
  });

  it("pruneFeedback + pruneBotReplies drop rows older than their windows", async () => {
    const { db, store } = await load();
    db.getDb();
    const DAY = 86_400_000;
    const NOW = Date.parse("2026-06-28T00:00:00.000Z");
    store.recordReply({ channelId: "C1", replyTs: "1.1", traceId: "T1" });
    db.getDb().prepare("UPDATE bot_replies SET created_at=? WHERE reply_ts='1.1'").run(new Date(NOW - 200 * DAY).toISOString());
    db.getDb().prepare(
      "INSERT INTO feedback (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at) VALUES ('T1','C1','1.1','U2','-1','negative',-1,?)"
    ).run(new Date(NOW - 200 * DAY).toISOString());

    expect(db.pruneFeedback(180, NOW)).toBe(1);
    expect(db.pruneBotReplies(90, NOW)).toBe(1);
    db.closeDb();
  });
});
