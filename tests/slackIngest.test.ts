import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DbPool } from "../src/state/db.js";
import {
  resolveIngestChannels,
  shouldIngestSlackMessage,
  MAX_EXTRACTIONS_PER_TICK,
  type SlackHistoryMessage,
} from "../src/memory/slackIngest.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

describe("resolveIngestChannels", () => {
  it("parses a comma-separated allowlist; empty → nothing", () => {
    expect(resolveIngestChannels({ MEMORY_SLACK_CHANNELS: "C1, C2 ,C1" })).toEqual(["C1", "C2"]);
    expect(resolveIngestChannels({})).toEqual([]);
  });
});

describe("shouldIngestSlackMessage", () => {
  const base: SlackHistoryMessage = { ts: "1", user: "U1", text: "x".repeat(100) };
  it("ingests a substantial human message", () => {
    expect(shouldIngestSlackMessage(base).ingest).toBe(true);
  });
  it("skips bot/automated and userless messages", () => {
    expect(shouldIngestSlackMessage({ ...base, bot_id: "B1" }).ingest).toBe(false);
    expect(shouldIngestSlackMessage({ ...base, subtype: "bot_message" }).ingest).toBe(false);
    expect(shouldIngestSlackMessage({ ts: "1", text: "x".repeat(100) }).ingest).toBe(false);
  });
  it("skips system-subtype and short messages", () => {
    expect(shouldIngestSlackMessage({ ...base, subtype: "channel_join" }).ingest).toBe(false);
    expect(shouldIngestSlackMessage({ ...base, text: "hi" }).ingest).toBe(false);
  });
});

// --- runSlackIngest (in-memory DB + mocked Slack + mocked extractor) ---------

async function setup() {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const slackIngest = await import("../src/memory/slackIngest.js");
  const client = await import("../src/llm/openaiClient.js");
  client.__resetBudgetForTests();
  delete process.env.MEMORY_ENTITY_GRAPH;
  return { db: getPool(), slackIngest };
}

// Every test message contains this exact phrase (a valid evidence quote) plus a
// unique [[id:N]] tag the fake echoes into the fact text (so no hash-dedup).
const EVIDENCE = "raise the placements target to 300 offers";

/** Extractor fetch that echoes one distinct, evidence-grounded fact per message. */
const fakeExtractor = (async (_url: string, init: any) => {
  const body = JSON.parse(init.body);
  const content: string = body.messages[1].content; // [0] is system, [1] is user
  const tag = content.match(/\[\[id:[^\]]+\]\]/)?.[0] ?? "[[id:x]]";
  const fact = {
    text: `Decision ${tag} recorded about placements`,
    category: "fact",
    entities: [],
    confidence: 0.9,
    evidence_quote: EVIDENCE,
    sensitivity: "normal",
  };
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify({ facts: [fact] }) }, finish_reason: "stop" }] }),
    { status: 200 }
  );
}) as unknown as typeof fetch;

function mockClient(byChannel: Record<string, SlackHistoryMessage[]>) {
  return {
    fetchHistory: async (channelId: string, oldestTs: string | undefined) => {
      const all = byChannel[channelId] ?? [];
      return oldestTs ? all.filter((m) => Number(m.ts) > Number(oldestTs)) : all;
    },
  };
}

function msg(ts: string, text: string): SlackHistoryMessage {
  return { ts, user: "U1", text };
}

describe("runSlackIngest", () => {
  let db: DbPool;
  let slackIngest: typeof import("../src/memory/slackIngest.js");
  beforeEach(async () => {
    ({ db, slackIngest } = await setup());
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("ingests a qualifying message: stores a capped 'conversation' fact, advances cursor, dedupes", async () => {
    const text =
      "[[id:a]] In the leadership sync we decided to raise the placements target to 300 offers this quarter and push hard on it";
    const slack = mockClient({ C1: [msg("1718323200.000100", text)] });
    await slackIngest.runSlackIngest({ slack, apiKey: "k", channels: ["C1"], fetchImpl: fakeExtractor });

    const rows = (await db.query("SELECT source_type, source_ref, confidence FROM memories")).rows as Array<{
      source_type: string; source_ref: string; confidence: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].source_type).toBe("conversation");
    expect(rows[0].source_ref).toBe("slack:C1:1718323200.000100");
    expect(rows[0].confidence).toBeLessThanOrEqual(slackIngest.SLACK_CONFIDENCE_CAP);

    const { getCursor } = await import("../src/memory/memorySql.js");
    expect(await getCursor(db, "slack:C1")).toBe("1718323200.0001");

    // Re-run: the message is already ingested → no new rows.
    const slack2 = mockClient({ C1: [msg("1718323200.000100", text)] });
    await slackIngest.runSlackIngest({ slack: slack2, apiKey: "k", channels: ["C1"], fetchImpl: fakeExtractor });
    const n = ((await db.query("SELECT COUNT(*) AS n FROM memories")).rows[0] as { n: number | string }).n;
    expect(Number(n)).toBe(1);
  });

  it("skips bot and short messages without extracting", async () => {
    const slack = mockClient({
      C1: [
        { ts: "2", user: "U1", text: "short" },
        { ts: "3", bot_id: "B1", text: "x".repeat(100) },
      ],
    });
    await slackIngest.runSlackIngest({ slack, apiKey: "k", channels: ["C1"], fetchImpl: fakeExtractor });
    const n = ((await db.query("SELECT COUNT(*) AS n FROM memories")).rows[0] as { n: number | string }).n;
    expect(Number(n)).toBe(0);
  });

  it("caps extractions per tick and leaves deferred messages behind the cursor", async () => {
    const many = Array.from({ length: MAX_EXTRACTIONS_PER_TICK + 3 }, (_, i) =>
      msg(
        `${1000 + i}.0001`,
        `[[id:${i}]] In today's leadership review we will raise the placements target to 300 offers across all campuses now`
      )
    );
    const slack = mockClient({ C1: many });
    await slackIngest.runSlackIngest({ slack, apiKey: "k", channels: ["C1"], fetchImpl: fakeExtractor });

    const n = Number(((await db.query("SELECT COUNT(*) AS n FROM memories")).rows[0] as { n: number | string }).n);
    expect(n).toBe(MAX_EXTRACTIONS_PER_TICK);

    // Cursor stops at the last EXTRACTED message (i = MAX-1) — deferred ones
    // (i >= MAX) stay strictly ahead so a later tick re-lists them.
    const { getCursor } = await import("../src/memory/memorySql.js");
    const cursor = Number(await getCursor(db, "slack:C1"));
    const lastExtractedTs = Number(`${1000 + (MAX_EXTRACTIONS_PER_TICK - 1)}.0001`);
    const firstDeferredTs = Number(`${1000 + MAX_EXTRACTIONS_PER_TICK}.0001`);
    expect(cursor).toBe(lastExtractedTs);
    expect(cursor).toBeLessThan(firstDeferredTs);
  });
});
