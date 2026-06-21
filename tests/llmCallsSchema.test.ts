import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (same pattern as the canonical DB-test template).
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

const INSERT = `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`;

describe("llm_calls provider CHECK (openai-only after the cutover)", () => {
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

  it("accepts provider = 'openai'", async () => {
    const { getPool } = await import("../src/state/db.js");
    const r = await getPool().query(INSERT, [
      "c1",
      "t1",
      "openai",
      "gpt-4o-mini",
      "extract",
      "ok",
      "2026-06-14T00:00:00.000Z",
    ]);
    expect(typeof r.rows[0].id).toBe("number");
  });

  it("rejects provider = 'google' via the CHECK", async () => {
    const { getPool } = await import("../src/state/db.js");
    await expect(
      getPool().query(INSERT, [
        "c1",
        "t1",
        "google",
        "gemini",
        "reply",
        "ok",
        "2026-06-14T00:00:00.000Z",
      ])
    ).rejects.toThrow();
  });

  it("rejects the legacy 'anthropic' provider via the CHECK", async () => {
    const { getPool } = await import("../src/state/db.js");
    await expect(
      getPool().query(INSERT, [
        "c1",
        "t1",
        "anthropic",
        "claude",
        "reply",
        "ok",
        "2026-06-14T00:00:00.000Z",
      ])
    ).rejects.toThrow();
  });
});
