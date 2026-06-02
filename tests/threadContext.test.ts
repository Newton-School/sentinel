import { describe, it, expect, vi } from "vitest";

// Silence pino — threadContext.ts -> logger.ts imports config, but the logger
// module only reads config.LOG_LEVEL at construction time. Mocking config keeps
// the import-time loadConfig()/process.exit out of the test.
vi.mock("../src/config.js", () => ({
  config: { LOG_LEVEL: "silent" },
}));

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

import { fetchThreadContext } from "../src/slack/threadContext.js";
import type { WebClient } from "@slack/web-api";

function makeClient(repliesImpl: (args: any) => Promise<any>): WebClient {
  return {
    conversations: {
      replies: vi.fn(repliesImpl),
    },
  } as unknown as WebClient;
}

describe("fetchThreadContext", () => {
  it("requests replies for the given channel + thread with a limit of 50", async () => {
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { user: "U0", text: "parent", ts: "1.0" },
        { user: "U1", text: "reply", ts: "1.1" },
      ],
    });
    const client = { conversations: { replies } } as unknown as WebClient;

    await fetchThreadContext(client, "C1", "1.0");

    expect(replies).toHaveBeenCalledWith({
      channel: "C1",
      ts: "1.0",
      limit: 50,
    });
  });

  it("maps replies (excluding the parent) to ThreadMessage objects", async () => {
    const client = makeClient(async () => ({
      messages: [
        { user: "U0", text: "parent question", ts: "1.0" },
        { user: "U1", text: "first reply", ts: "1.1" },
        { user: "U2", text: "second reply", ts: "1.2" },
      ],
    }));

    const result = await fetchThreadContext(client, "C1", "1.0");

    expect(result).toEqual([
      { userId: "U1", text: "first reply", ts: "1.1" },
      { userId: "U2", text: "second reply", ts: "1.2" },
    ]);
  });

  it("returns [] when the thread has only the parent message", async () => {
    const client = makeClient(async () => ({
      messages: [{ user: "U0", text: "parent only", ts: "1.0" }],
    }));

    const result = await fetchThreadContext(client, "C1", "1.0");
    expect(result).toEqual([]);
  });

  it("returns [] when there are no messages at all", async () => {
    const client = makeClient(async () => ({ messages: [] }));
    const result = await fetchThreadContext(client, "C1", "1.0");
    expect(result).toEqual([]);
  });

  it("falls back to defaults for missing user/text/ts fields", async () => {
    const client = makeClient(async () => ({
      messages: [
        { user: "U0", text: "parent", ts: "1.0" },
        { ts: "1.1" }, // no user, no text
      ],
    }));

    const result = await fetchThreadContext(client, "C1", "1.0");
    expect(result).toEqual([{ userId: "unknown", text: "", ts: "1.1" }]);
  });

  it("caps the thread fetch at 50 via the API request limit (the 50-cap is request-side, not output-side)", async () => {
    // The 50-cap is enforced by passing `limit: 50` to conversations.replies,
    // which bounds the page Slack returns. The function itself does NOT
    // re-truncate its output — it returns every reply the API hands back
    // (minus the parent). This test documents that actual behavior: the cap
    // lives on the request, so a well-behaved Slack honoring `limit` yields
    // <= 50 replies. See report note about adding a defensive .slice(0, 50).
    const replies = vi.fn().mockResolvedValue({
      messages: [
        { user: "U0", text: "parent", ts: "0" },
        { user: "U1", text: "reply", ts: "1" },
      ],
    });
    const client = { conversations: { replies } } as unknown as WebClient;

    await fetchThreadContext(client, "C1", "0");

    // The request limit is what bounds the result at 50.
    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 })
    );
  });

  it("swallows API errors and returns [] (does not throw)", async () => {
    const client = makeClient(async () => {
      throw new Error("slack_api_error: ratelimited");
    });

    await expect(
      fetchThreadContext(client, "C1", "1.0")
    ).resolves.toEqual([]);
  });
});
