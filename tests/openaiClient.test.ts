import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Intercept the LLM trace sink so telemetry recording is observable and never
// touches the DB. The spy is hoisted so it survives vi.resetModules() and is
// the same instance the freshly-imported client calls.
const { recordLlmCallSpy } = vi.hoisted(() => ({ recordLlmCallSpy: vi.fn() }));
vi.mock("../src/llm/traceStore.js", () => ({ recordLlmCall: recordLlmCallSpy }));

/** Response-like fake for the injected fetch. */
function apiResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

/** A successful OpenAI chat-completions response whose content is JSON. */
function successBody(payload: unknown, finishReason = "stop"): unknown {
  return {
    choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: finishReason }],
  };
}

const SCHEMA = {
  type: "object",
  properties: { facts: { type: "array" } },
  required: ["facts"],
  additionalProperties: false,
};

async function importClient() {
  // No keys in config → openaiApiKey() is undefined unless a test passes one.
  vi.doMock("../src/config.js", () => ({ config: { LOG_LEVEL: "silent" } }));
  return import("../src/llm/openaiClient.js");
}

describe("openaiClient.extractJson", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("sends an OpenAI chat-completions request (model, system+user, json_object)", async () => {
    const { extractJson, __resetBudgetForTests, OPENAI_EXTRACT_MODEL } = await importClient();
    __resetBudgetForTests();
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return apiResponse(successBody({ facts: [{ ok: 1 }] }));
    }) as unknown as typeof fetch;

    const result = await extractJson({
      system: "SYS", user: "USER", schema: SCHEMA, apiKey: "sk-test", fetchImpl, now: () => 0,
    });

    expect(result).toEqual({ facts: [{ ok: 1 }] });
    expect(captured!.url).toContain("api.openai.com/v1/chat/completions");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe(OPENAI_EXTRACT_MODEL);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("SYS");
    expect(body.messages[1]).toEqual({ role: "user", content: "USER" });
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("honors model + maxTokens overrides", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    let body: any;
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return apiResponse(successBody({ facts: [] }));
    }) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, model: "gpt-4o", maxTokens: 256, apiKey: "k", fetchImpl, now: () => 0 });
    expect(body.model).toBe("gpt-4o");
    expect(body.max_tokens).toBe(256);
  });

  it("returns null without an API key (no fetch)", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    let called = false;
    const fetchImpl = (async () => { called = true; return apiResponse({}); }) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, fetchImpl, now: () => 0 })).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null on a non-ok response", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => apiResponse({ error: {} }, 500)) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 })).toBeNull();
  });

  it("returns null on a refusal or length-truncated choice", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const refusal = (async () => apiResponse({ choices: [{ message: { refusal: "no" } }] })) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl: refusal, now: () => 0 })).toBeNull();
    const truncated = (async () => apiResponse({ choices: [{ message: { content: "{" }, finish_reason: "length" }] })) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl: truncated, now: () => 0 })).toBeNull();
  });

  it("returns null when the content is JSON garbage", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => apiResponse({ choices: [{ message: { content: "not json" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 })).toBeNull();
  });

  it("returns null (never throws) on a network error", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 })).toBeNull();
  });

  it("blocks past the daily budget without fetching, and resets on a new UTC day", async () => {
    const { extractJson, __resetBudgetForTests, MAX_EXTRACTION_CALLS_PER_DAY } = await importClient();
    __resetBudgetForTests();
    let calls = 0;
    const fetchImpl = (async () => { calls++; return apiResponse(successBody({ facts: [] })); }) as unknown as typeof fetch;
    const day1 = Date.parse("2026-06-15T00:00:00Z");
    for (let i = 0; i < MAX_EXTRACTION_CALLS_PER_DAY; i++) {
      await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => day1 });
    }
    expect(calls).toBe(MAX_EXTRACTION_CALLS_PER_DAY);
    // 501st same-day call is blocked (no fetch)
    expect(await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => day1 })).toBeNull();
    expect(calls).toBe(MAX_EXTRACTION_CALLS_PER_DAY);
    // next UTC day resets
    const day2 = Date.parse("2026-06-16T00:00:00Z");
    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => day2 });
    expect(calls).toBe(MAX_EXTRACTION_CALLS_PER_DAY + 1);
  });
});

describe("openaiClient.extractJson — telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    recordLlmCallSpy.mockClear();
  });

  function bodyWithUsage(payload: unknown, usage: unknown): unknown {
    return {
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: "stop" }],
      usage,
    };
  }

  it("records an openai 'extract' call with usage tokens + computed cost on success", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () =>
      apiResponse(bodyWithUsage({ facts: [] }, { prompt_tokens: 100, completion_tokens: 50 }))) as unknown as typeof fetch;

    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 });

    expect(recordLlmCallSpy).toHaveBeenCalledTimes(1);
    const arg = recordLlmCallSpy.mock.calls[0][0];
    expect(arg.provider).toBe("openai");
    expect(arg.operation).toBe("extract");
    expect(arg.model).toBe("gpt-4o-mini");
    expect(arg.inputTokens).toBe(100);
    expect(arg.outputTokens).toBe(50);
    expect(arg.status).toBe("ok");
    // 100/1000*0.00015 + 50/1000*0.00060 = 0.000045
    expect(arg.costUsd).toBeCloseTo(0.000045, 12);
    expect(typeof arg.latencyMs).toBe("number");
  });

  it("tags operation + model from options (consolidate via gpt-4o)", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () =>
      apiResponse(bodyWithUsage({ profile_md: "x" }, { prompt_tokens: 10, completion_tokens: 5 }))) as unknown as typeof fetch;

    await extractJson({ system: "s", user: "u", schema: SCHEMA, model: "gpt-4o", operation: "consolidate", apiKey: "k", fetchImpl, now: () => 0 });

    const arg = recordLlmCallSpy.mock.calls[0][0];
    expect(arg.operation).toBe("consolidate");
    expect(arg.model).toBe("gpt-4o");
  });

  it("records an error call on a non-ok HTTP response", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => apiResponse({ error: {} }, 500)) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 });
    const arg = recordLlmCallSpy.mock.calls[0][0];
    expect(arg.status).toBe("error");
    expect(arg.errorKind).toBe("http");
  });

  it("records an error call on a refusal/length-truncated choice", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () =>
      apiResponse({ choices: [{ message: { content: "{" }, finish_reason: "length" }] })) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 });
    expect(recordLlmCallSpy.mock.calls[0][0].status).toBe("error");
    expect(recordLlmCallSpy.mock.calls[0][0].errorKind).toBe("unusable");
  });

  it("records an error call (parse) on JSON garbage", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () =>
      apiResponse({ choices: [{ message: { content: "not json" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 });
    expect(recordLlmCallSpy.mock.calls[0][0].errorKind).toBe("parse");
  });

  it("records an error call (network) when fetch throws", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, apiKey: "k", fetchImpl, now: () => 0 });
    expect(recordLlmCallSpy.mock.calls[0][0].errorKind).toBe("network");
  });

  it("does NOT record a call when there is no API key (skipped, not attempted)", async () => {
    const { extractJson, __resetBudgetForTests } = await importClient();
    __resetBudgetForTests();
    const fetchImpl = (async () => apiResponse(successBody({ facts: [] }))) as unknown as typeof fetch;
    await extractJson({ system: "s", user: "u", schema: SCHEMA, fetchImpl, now: () => 0 });
    expect(recordLlmCallSpy).not.toHaveBeenCalled();
  });
});
