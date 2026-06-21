import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (joinStore.test.ts pattern).
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const LONG_QUERY =
  "We decided to move the launch to July 15 and Priya owns the pricing page revamp.";

function fact(overrides: Record<string, unknown> = {}) {
  return {
    text: "Launch moved to July 15 per leadership decision.",
    category: "decision",
    entities: ["launch"],
    confidence: 0.9,
    evidence_quote: "move the launch to July 15",
    sensitivity: "normal",
    ...overrides,
  };
}

/**
 * Loads conversationHook with a mocked config (in-memory DB) and a mocked
 * extractor. Returns the hook module, the extractFacts spy, and getDb.
 */
async function loadHook(opts: {
  apiKey?: string;
  extractFacts?: ReturnType<typeof vi.fn>;
}) {
  vi.doMock("../src/config.js", () => ({
    config: {
      DATABASE_URL: process.env.DATABASE_URL,
      PG_POOL_MAX: 5,
      LOG_LEVEL: "silent",
      ...(opts.apiKey ? { OPENAI_API_KEY: opts.apiKey } : {}),
    },
  }));
  const extractFacts = opts.extractFacts ?? vi.fn(async () => []);
  vi.doMock("../src/memory/extractor.js", () => ({ extractFacts }));

  const hook = await import("../src/memory/conversationHook.js");
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  return { hook, extractFacts, getDb: getPool };
}

describe("conversationHook.extractFromConversation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("never throws and never rejects, even when the extractor explodes", async () => {
    const exploding = vi.fn(async () => {
      throw new Error("extractor boom");
    });
    const { hook } = await loadHook({
      apiKey: "sk-ant-test",
      extractFacts: exploding,
    });

    expect(() =>
      hook.extractFromConversation({
        queryText: LONG_QUERY,
        responseText: "reply",
        channelId: "C123",
        threadTs: "1718000000.000100",
        injectedMemories: [],
      })
    ).not.toThrow();

    // The fire-and-forget promise must settle without rejecting.
    await expect(hook.__testing.flush()).resolves.toBeUndefined();
    expect(exploding).toHaveBeenCalledTimes(1);

    // A synchronously-throwing extractor must also be contained.
    exploding.mockImplementation(() => {
      throw new Error("sync boom");
    });
    expect(() =>
      hook.extractFromConversation({
        queryText: LONG_QUERY,
        responseText: "reply",
        channelId: "C123",
        threadTs: "1718000000.000100",
        injectedMemories: [],
      })
    ).not.toThrow();
    await expect(hook.__testing.flush()).resolves.toBeUndefined();
  });

  it("skips extraction when no OpenAI key is set", async () => {
    const { hook, extractFacts } = await loadHook({ apiKey: undefined });

    hook.extractFromConversation({
      queryText: LONG_QUERY,
      responseText: "reply",
      channelId: "C123",
      threadTs: "1718000000.000100",
      injectedMemories: [],
    });
    await hook.__testing.flush();

    expect(extractFacts).not.toHaveBeenCalled();
  });

  it("skips extraction when queryText is shorter than 40 chars", async () => {
    const { hook, extractFacts } = await loadHook({ apiKey: "sk-ant-test" });

    hook.extractFromConversation({
      queryText: "what's our MRR?",
      responseText: "reply",
      channelId: "C123",
      threadTs: "1718000000.000100",
      injectedMemories: [],
    });
    await hook.__testing.flush();

    expect(extractFacts).not.toHaveBeenCalled();
  });

  it("inserts extracted facts with conversation provenance and confidence capped at 0.6", async () => {
    const extractFacts = vi.fn(async () => [
      fact({ confidence: 0.9 }),
      fact({
        text: "Priya owns the pricing page revamp project.",
        category: "owner",
        entities: ["Priya"],
        confidence: 0.4,
        evidence_quote: "Priya owns the pricing page revamp",
      }),
    ]);
    const { hook, getDb } = await loadHook({
      apiKey: "sk-ant-test",
      extractFacts,
    });

    hook.extractFromConversation({
      queryText: LONG_QUERY,
      responseText: "reply",
      channelId: "C123",
      threadTs: "1718000000.000100",
      injectedMemories: [],
    });
    await hook.__testing.flush();

    const rows = (
      await getDb().query(
        `SELECT text, source_type, source_ref, source_label, confidence, evidence_quote
         FROM memories ORDER BY id`
      )
    ).rows as Array<{
      text: string;
      source_type: string;
      source_ref: string;
      source_label: string;
      confidence: number;
      evidence_quote: string;
    }>;

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.source_type).toBe("conversation");
      expect(row.source_ref).toBe("slack:C123:1718000000.000100");
      expect(row.source_label).toMatch(/^Q&A \d{4}-\d{2}-\d{2}$/);
      expect(row.confidence).toBeLessThanOrEqual(0.6);
    }
    // 0.9 is capped to the conversation prior of 0.6; 0.4 passes through.
    expect(rows[0].confidence).toBe(0.6);
    expect(rows[1].confidence).toBe(0.4);
    expect(rows[0].evidence_quote).toBe("move the launch to July 15");
  });

  it("passes injectedMemories as alreadyKnown and the response as truncated disambiguation context", async () => {
    const extractFacts = vi.fn(async () => []);
    const { hook } = await loadHook({ apiKey: "sk-ant-test", extractFacts });

    const injected = ["Priya owns pricing", "Launch is in July"];
    const longResponse = "r".repeat(3000);

    hook.extractFromConversation({
      queryText: LONG_QUERY,
      responseText: longResponse,
      channelId: "C123",
      threadTs: "1718000000.000100",
      injectedMemories: injected,
    });
    await hook.__testing.flush();

    expect(extractFacts).toHaveBeenCalledTimes(1);
    const input = extractFacts.mock.calls[0][0] as Record<string, unknown>;
    expect(input.sourceType).toBe("conversation");
    expect(input.content).toBe(LONG_QUERY); // user-turn-grounded: query ONLY
    expect(input.alreadyKnown).toEqual(injected);
    expect(input.apiKey).toBe("sk-ant-test");
    expect((input.disambiguationContext as string).length).toBeLessThanOrEqual(
      2000
    );
  });
});
