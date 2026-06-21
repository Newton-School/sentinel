import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Queryable } from "../src/state/db.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/** Insert an llm_calls row with an explicit created_at ISO timestamp. */
async function insertRow(q: Queryable, traceId: string, createdAtMs: number): Promise<void> {
  await q.query(
    `INSERT INTO llm_calls (call_id, trace_id, provider, model, operation, status, created_at)
     VALUES ($1, $2, 'openai', 'gpt-4o-mini', 'extract', 'ok', $3)`,
    [`${traceId}:${createdAtMs}`, traceId, new Date(createdAtMs).toISOString()]
  );
}

describe("pruneLlmCalls", () => {
  let pruneLlmCalls: typeof import("../src/state/db.js").pruneLlmCalls;
  let getPool: typeof import("../src/state/db.js").getPool;

  const DAY_MS = 24 * 60 * 60 * 1000;
  const NOW = Date.parse("2026-06-02T00:00:00.000Z");

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));

    const mod = await import("../src/state/db.js");
    getPool = mod.getPool;
    pruneLlmCalls = mod.pruneLlmCalls;
    await mod.initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("deletes rows older than the retention window and keeps recent rows", async () => {
    await insertRow(getPool(), "T1", NOW - 100 * DAY_MS);
    await insertRow(getPool(), "T2", NOW - 91 * DAY_MS);
    await insertRow(getPool(), "T3", NOW - 89 * DAY_MS);
    await insertRow(getPool(), "T4", NOW);

    const deleted = await pruneLlmCalls(90, NOW);

    expect(deleted).toBe(2);
    const remaining = (
      await getPool().query("SELECT trace_id FROM llm_calls ORDER BY trace_id")
    ).rows as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T3", "T4"]);
  });

  it("keeps a row exactly at the retention boundary", async () => {
    await insertRow(getPool(), "T1", NOW - 90 * DAY_MS);
    expect(await pruneLlmCalls(90, NOW)).toBe(0);
    const count = Number(
      ((await getPool().query("SELECT COUNT(*) AS c FROM llm_calls")).rows[0] as { c: string }).c
    );
    expect(count).toBe(1);
  });

  it("respects a custom retention window", async () => {
    await insertRow(getPool(), "T1", NOW - 40 * DAY_MS);
    await insertRow(getPool(), "T2", NOW - 20 * DAY_MS);
    expect(await pruneLlmCalls(30, NOW)).toBe(1);
    const remaining = (await getPool().query("SELECT trace_id FROM llm_calls")).rows as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T2"]);
  });

  it("defaults retention to 90 days and uses the current time when nowMs is omitted", async () => {
    await insertRow(getPool(), "T_old", Date.now() - 200 * DAY_MS);
    await insertRow(getPool(), "T_new", Date.now());
    expect(await pruneLlmCalls()).toBe(1);
    const remaining = (await getPool().query("SELECT trace_id FROM llm_calls")).rows as Array<{ trace_id: string }>;
    expect(remaining.map((r) => r.trace_id)).toEqual(["T_new"]);
  });
});
