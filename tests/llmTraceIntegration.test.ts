import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Headline integration test for the LLMOps foundation: prove that an OpenAI
// call launched DETACHED (fire-and-forget) inside a request's trace scope —
// exactly how src/index.ts's `finally` launches fact extraction — writes an
// llm_calls row correlated by that request's trace_id. This exercises the real
// chain: extractJson → recordLlmCall → traceStore → Postgres, with the trace id
// flowing through AsyncLocalStorage across the await boundary.

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

function apiResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

async function load() {
  vi.resetModules();
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
  const { extractJson } = await import("../src/llm/openaiClient.js");
  const { runWithTrace } = await import("../src/llm/traceContext.js");
  return { db, extractJson, runWithTrace };
}

/**
 * recordLlmCall is a synchronous fire-and-forget sink: it launches the durable
 * INSERT as a floating promise that may not have landed by the time the caller's
 * own await resolves. Poll the table until the expected row count appears.
 */
async function waitForRows(
  db: typeof import("../src/state/db.js"),
  minRows = 1,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await db.getPool().query("SELECT COUNT(*) AS c FROM llm_calls");
    if (Number((rows[0] as { c: string }).c) >= minRows) return;
    if (Date.now() > deadline) throw new Error("timed out waiting for llm_calls rows");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("LLM trace correlation (request fan-out)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("a detached OpenAI call inside a trace writes an llm_calls row carrying that trace_id", async () => {
    const { db, extractJson, runWithTrace } = await load();

    const fetchImpl = (async () =>
      apiResponse({
        choices: [{ message: { content: JSON.stringify({ facts: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      })) as unknown as typeof fetch;

    let inflight: Promise<unknown> = Promise.resolve();
    runWithTrace({ traceId: "REQ-1", userId: "U9" }, () => {
      // Launched synchronously inside the scope, then awaits — exactly the
      // shape of index.ts's fire-and-forget extractFromConversation.
      inflight = (async () => {
        await Promise.resolve();
        return extractJson({
          system: "s",
          user: "u",
          schema: { type: "object" },
          apiKey: "k",
          operation: "extract",
          fetchImpl,
        });
      })();
    });
    await inflight;
    await waitForRows(db);

    const row = (
      await db
        .getPool()
        .query(
          "SELECT trace_id, user_id, provider, operation, status, input_tokens FROM llm_calls"
        )
    ).rows[0] as Record<string, unknown>;
    expect(row.trace_id).toBe("REQ-1");
    expect(row.user_id).toBe("U9");
    expect(row.provider).toBe("openai");
    expect(row.operation).toBe("extract");
    expect(row.status).toBe("ok");
    expect(row.input_tokens).toBe(10);
  });

  it("a call outside any trace scope is recorded as 'untraced'", async () => {
    const { db, extractJson } = await load();
    const fetchImpl = (async () =>
      apiResponse({
        choices: [{ message: { content: JSON.stringify({ facts: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })) as unknown as typeof fetch;

    await extractJson({ system: "s", user: "u", schema: { type: "object" }, apiKey: "k", fetchImpl });
    await waitForRows(db);

    const row = (await db.getPool().query("SELECT trace_id FROM llm_calls")).rows[0] as { trace_id: string };
    expect(row.trace_id).toBe("untraced");
  });
});
