import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Mock upsertTrait since we're testing trackQuery, not trait logic.
vi.mock("../src/persona/store.js", () => ({
  upsertTrait: vi.fn(),
}));

describe("audit logging", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { initDb } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  async function columnNames(table: string): Promise<string[]> {
    const { getPool } = await import("../src/state/db.js");
    return (await getPool().query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      [table]
    )).rows.map((r: { column_name: string }) => r.column_name);
  }

  describe("query_log schema", () => {
    it("has response_text column", async () => {
      expect(await columnNames("query_log")).toContain("response_text");
    });

    it("has response_duration_ms column", async () => {
      expect(await columnNames("query_log")).toContain("response_duration_ms");
    });

    it("has sources_used column", async () => {
      expect(await columnNames("query_log")).toContain("sources_used");
    });
  });

  describe("trackQuery", () => {
    it("stores query text and response text", async () => {
      const { trackQuery } = await import("../src/persona/tracker.js");
      const { getPool } = await import("../src/state/db.js");
      await trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "What are the placement numbers?",
        responseText: "Placements are up 15% this month.",
        responseDurationMs: 5000,
      });

      const row = (await getPool().query("SELECT * FROM query_log WHERE user_id = $1", ["U123"])).rows[0] as Record<string, unknown>;
      expect(row.query_text).toBe("What are the placement numbers?");
      expect(row.response_text).toBe("Placements are up 15% this month.");
      expect(row.response_duration_ms).toBe(5000);
    });

    it("stores sources_used as JSON", async () => {
      const { trackQuery } = await import("../src/persona/tracker.js");
      const { getPool } = await import("../src/state/db.js");
      await trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "What are the placement numbers?",
        responseText: "Answer here",
        sourcesUsed: ["Metabase", "Slack"],
      });

      const row = (await getPool().query("SELECT * FROM query_log WHERE user_id = $1", ["U123"])).rows[0] as Record<string, unknown>;
      expect(row.sources_used).toBe(JSON.stringify(["Metabase", "Slack"]));
    });

    it("stores null for optional fields when not provided", async () => {
      const { trackQuery } = await import("../src/persona/tracker.js");
      const { getPool } = await import("../src/state/db.js");
      await trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "Give me an update",
      });

      const row = (await getPool().query("SELECT * FROM query_log WHERE user_id = $1", ["U123"])).rows[0] as Record<string, unknown>;
      expect(row.response_text).toBeNull();
      expect(row.response_duration_ms).toBeNull();
      expect(row.sources_used).toBeNull();
    });

    it("categorizes the query and stores category", async () => {
      const { trackQuery } = await import("../src/persona/tracker.js");
      const { getPool } = await import("../src/state/db.js");
      await trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "How are admissions looking?",
        responseText: "Admissions are steady.",
      });

      const row = (await getPool().query("SELECT * FROM query_log WHERE user_id = $1", ["U123"])).rows[0] as Record<string, unknown>;
      expect(row.category).toBe("admissions");
    });

    it("stores created_at timestamp", async () => {
      const { trackQuery } = await import("../src/persona/tracker.js");
      const { getPool } = await import("../src/state/db.js");
      await trackQuery({
        userId: "U123",
        channelId: "C456",
        threadTs: "1234567890.123",
        queryText: "hello",
      });

      const row = (await getPool().query("SELECT * FROM query_log WHERE user_id = $1", ["U123"])).rows[0] as Record<string, unknown>;
      expect(row.created_at).toBeTruthy();
      // Should be a valid ISO date
      expect(() => new Date(row.created_at as string)).not.toThrow();
    });
  });
});
