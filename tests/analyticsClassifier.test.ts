import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Intercept the OpenAI client so no network call happens and we can drive the
// classifier's decision + inspect how it calls extractJson.
const extractJsonMock = vi.fn();
const openaiApiKeyMock = vi.fn(() => "sk-test" as string | undefined);
vi.mock("../src/llm/openaiClient.js", () => ({
  extractJson: (...args: unknown[]) => extractJsonMock(...args),
  openaiApiKey: () => openaiApiKeyMock(),
  OPENAI_EXTRACT_MODEL: "gpt-4o-mini",
}));

import { classifyAnalyticsIntent } from "../src/analytics/classifier.js";

describe("classifyAnalyticsIntent", () => {
  beforeEach(() => {
    extractJsonMock.mockReset();
    openaiApiKeyMock.mockReturnValue("sk-test");
  });

  it("returns 'analytics' when the model classifies it as analytics", async () => {
    extractJsonMock.mockResolvedValue({ intent: "analytics", confidence: 0.92 });
    expect(await classifyAnalyticsIntent("how many DS Certification enrollments in Feb 2026?")).toBe(
      "analytics"
    );
  });

  it("returns 'general' when the model classifies it as general", async () => {
    extractJsonMock.mockResolvedValue({ intent: "general", confidence: 0.81 });
    expect(await classifyAnalyticsIntent("summarize today's standup")).toBe("general");
  });

  it("falls back to 'general' when extractJson returns null (no key / budget / error)", async () => {
    extractJsonMock.mockResolvedValue(null);
    expect(await classifyAnalyticsIntent("anything at all")).toBe("general");
  });

  it("falls back to 'general' on a malformed / unexpected response shape", async () => {
    extractJsonMock.mockResolvedValue({ foo: "bar" });
    expect(await classifyAnalyticsIntent("anything at all")).toBe("general");
  });

  it("short-circuits to 'general' WITHOUT calling the model when no API key is configured", async () => {
    openaiApiKeyMock.mockReturnValue(undefined);
    expect(await classifyAnalyticsIntent("how many enrollments?")).toBe("general");
    expect(extractJsonMock).not.toHaveBeenCalled();
  });

  it("uses a dedicated 'classify' budget bucket, skips the trace, and passes the message as the user turn", async () => {
    extractJsonMock.mockResolvedValue({ intent: "analytics" });
    await classifyAnalyticsIntent("enrollments by month?");
    expect(extractJsonMock).toHaveBeenCalledTimes(1);
    const opts = extractJsonMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.budgetBucket).toBe("classify");
    expect(opts.recordTrace).toBe(false);
    expect(opts.user).toBe("enrollments by month?");
    expect(String(opts.system)).toContain("intent router");
  });
});
