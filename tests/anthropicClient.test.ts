import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pino (same pattern as joinStore.test.ts) — the client's logger
// transitively imports config, which we also mock so tests need no real env.
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

/** Response-like fake for the injected fetch (httpRetry.test.ts pattern). */
function apiResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** A successful Messages API response whose text block is JSON. */
function successBody(payload: unknown, stopReason = "end_turn"): unknown {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    stop_reason: stopReason,
  };
}

const SCHEMA = {
  type: "object",
  properties: { facts: { type: "array" } },
  required: ["facts"],
  additionalProperties: false,
};

async function importClient() {
  vi.doMock("../src/config.js", () => ({
    config: { LOG_LEVEL: "silent" },
  }));
  return import("../src/llm/anthropicClient.js");
}

describe("anthropicClient.extractJson", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sends the exact Messages API request shape with structured outputs", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();

    const fetchImpl = vi.fn(async () =>
      apiResponse(successBody({ facts: [1, 2] }))
    );

    const result = await extractJson({
      system: "SYS",
      user: "USER CONTENT",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ facts: [1, 2] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");

    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.max_tokens).toBe(1024);
    expect(body.system).toBe("SYS");
    expect(body.messages).toEqual([{ role: "user", content: "USER CONTENT" }]);
    expect(body.output_config).toEqual({
      format: { type: "json_schema", schema: SCHEMA },
    });
  });

  it("honors a maxTokens override", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () => apiResponse(successBody({ ok: true })));

    await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      maxTokens: 256,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const body = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string
    );
    expect(body.max_tokens).toBe(256);
  });

  it("on HTTP 400 retries ONCE without output_config and with the JSON-only instruction", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(apiResponse({ error: "bad" }, 400))
      .mockResolvedValueOnce(apiResponse(successBody({ facts: [] })));

    const result = await extractJson({
      system: "SYS",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ facts: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(
      (fetchImpl.mock.calls[1][1] as RequestInit).body as string
    );
    expect(retryBody.output_config).toBeUndefined();
    expect(retryBody.system).toContain(
      "Respond with ONLY a single valid JSON object matching this schema, no prose:"
    );
    expect(retryBody.system).toContain(JSON.stringify(SCHEMA));
    // Original system prompt is preserved (instruction is appended).
    expect(retryBody.system).toContain("SYS");
  });

  it("returns null (no second fallback) when the fallback request also 400s", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();

    const fetchImpl = vi.fn(async () => apiResponse({ error: "bad" }, 400));

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns null on stop_reason refusal", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () =>
      apiResponse(successBody({ facts: [] }, "refusal"))
    );

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null on stop_reason max_tokens", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () =>
      apiResponse(successBody({ facts: [] }, "max_tokens"))
    );

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null on a non-ok, non-400 response", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () => apiResponse({ error: "nope" }, 403));

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns null when the text content is JSON garbage", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () =>
      apiResponse({
        content: [{ type: "text", text: "not json {{{" }],
        stop_reason: "end_turn",
      })
    );

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null when the response has no text block", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () =>
      apiResponse({ content: [], stop_reason: "end_turn" })
    );

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      apiKey: "sk-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null without calling fetch when no apiKey is provided", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn();

    const result = await extractJson({
      system: "s",
      user: "u",
      schema: SCHEMA,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null (never throws) when fetch fails with a network error", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      extractJson({
        system: "s",
        user: "u",
        schema: SCHEMA,
        apiKey: "sk-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      })
    ).resolves.toBeNull();
  });

  it("blocks the 501st call in a UTC day without fetching, and resets on UTC date change", async () => {
    const { extractJson, __resetBudgetForTests, MAX_EXTRACTION_CALLS_PER_DAY } =
      await importClient();
    __resetBudgetForTests();
    expect(MAX_EXTRACTION_CALLS_PER_DAY).toBe(500);

    let nowMs = Date.UTC(2026, 5, 11, 10, 0, 0);
    const now = () => nowMs;
    const fetchImpl = vi.fn(async () =>
      apiResponse(successBody({ facts: [] }))
    );

    const call = () =>
      extractJson({
        system: "s",
        user: "u",
        schema: SCHEMA,
        apiKey: "sk-test",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now,
      });

    for (let i = 0; i < MAX_EXTRACTION_CALLS_PER_DAY; i++) {
      expect(await call()).toEqual({ facts: [] });
    }
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_EXTRACTION_CALLS_PER_DAY);

    // 501st call on the same UTC day: blocked, fetch NOT called.
    expect(await call()).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_EXTRACTION_CALLS_PER_DAY);

    // Next UTC day: counter resets, the call goes through.
    nowMs += 24 * 60 * 60 * 1000;
    expect(await call()).toEqual({ facts: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_EXTRACTION_CALLS_PER_DAY + 1);
  });
});
