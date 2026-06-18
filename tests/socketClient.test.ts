import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config BEFORE importing socketClient. socketClient.ts (and the logger it
// pulls in) import `../src/config.js`, which runs loadConfig()/process.exit on
// invalid env at import time — mocking it avoids that side effect and lets us
// control BOT_USER_ID / ALLOWED_USER_IDS deterministically.
vi.mock("../src/config.js", () => ({
  config: {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    BOT_USER_ID: "UBOT",
    SENTINEL_OWNER_USER_ID: "UOWNER",
    SENTINEL_ACCESS_GROUP_HANDLE: "sentinel-access-group",
    // Kept in config but NO LONGER used by isAllowed (memory-founder default only).
    ALLOWED_USER_IDS: ["U1", "U2", "ULEGACY"],
    LOG_LEVEL: "silent",
  },
}));

// Silence pino so log.warn() calls in the handlers don't spam test output.
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

import {
  isAllowed,
  stripBotMention,
  isUserDmMessage,
  normalizeMention,
  normalizeDmMessage,
  normalizeSlashCommand,
  normalizeReactionAdded,
  normalizeFeedbackAction,
} from "../src/slack/socketClient.js";
import { __setAccessMembersForTests } from "../src/slack/accessGroup.js";

describe("normalizeFeedbackAction", () => {
  const body = { user: { id: "U1" }, channel: { id: "C1" }, message: { ts: "9.9", blocks: [{ type: "section" }] } };

  it("maps feedback_up → positive and feedback_down → negative", () => {
    expect(normalizeFeedbackAction("feedback_up", body)).toMatchObject({ reactorUserId: "U1", channelId: "C1", replyTs: "9.9", sentiment: "positive" });
    expect(normalizeFeedbackAction("feedback_down", body)?.sentiment).toBe("negative");
  });

  it("carries the message blocks for in-place acknowledgement", () => {
    expect(normalizeFeedbackAction("feedback_up", body)?.messageBlocks).toEqual([{ type: "section" }]);
  });

  it("returns null for non-feedback actions or missing fields", () => {
    expect(normalizeFeedbackAction("some_other_button", body)).toBeNull();
    expect(normalizeFeedbackAction("feedback_up", { user: { id: "U1" }, channel: { id: "C1" } })).toBeNull();
    expect(normalizeFeedbackAction("feedback_up", { channel: { id: "C1" }, message: { ts: "9.9" } })).toBeNull();
  });
});

describe("normalizeReactionAdded", () => {
  it("normalizes a reaction on a message into an envelope", () => {
    expect(
      normalizeReactionAdded({ user: "U1", reaction: "+1", item: { type: "message", channel: "C1", ts: "12.3" } })
    ).toEqual({ reactorUserId: "U1", channelId: "C1", itemTs: "12.3", reaction: "+1" });
  });

  it("returns null for reactions on non-message items (e.g. files)", () => {
    expect(
      normalizeReactionAdded({ user: "U1", reaction: "+1", item: { type: "file", channel: "C1", ts: "12.3" } })
    ).toBeNull();
  });

  it("returns null when required fields are missing", () => {
    expect(normalizeReactionAdded({ reaction: "+1", item: { type: "message", channel: "C1", ts: "1" } })).toBeNull();
    expect(normalizeReactionAdded({ user: "U1", item: { type: "message", channel: "C1", ts: "1" } })).toBeNull();
    expect(normalizeReactionAdded({ user: "U1", reaction: "+1" })).toBeNull();
  });
});

describe("isAllowed (authorization gate)", () => {
  beforeEach(() => __setAccessMembersForTests(["U1", "U2"]));

  it("always allows the owner", () => {
    expect(isAllowed("UOWNER")).toBe(true);
  });

  it("allows current access-group members", () => {
    expect(isAllowed("U1")).toBe(true);
    expect(isAllowed("U2")).toBe(true);
  });

  it("rejects users NOT in the group — incl. legacy ALLOWED_USER_IDS entries", () => {
    // ALLOWED_USER_IDS no longer grants entry: ULEGACY is in it but not the group.
    expect(isAllowed("ULEGACY")).toBe(false);
    expect(isAllowed("U3")).toBe(false);
    expect(isAllowed("UEVIL")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isAllowed("")).toBe(false);
  });

  it("does not match on substrings (no accidental prefix bypass)", () => {
    expect(isAllowed("U")).toBe(false);
    expect(isAllowed("U11")).toBe(false);
  });

  it("revokes access when a user leaves the group (owner still allowed)", () => {
    __setAccessMembersForTests([]);
    expect(isAllowed("U1")).toBe(false);
    expect(isAllowed("UOWNER")).toBe(true);
  });
});

describe("stripBotMention", () => {
  it("removes a leading <@BOT_USER_ID> mention and surrounding whitespace", () => {
    expect(stripBotMention("<@UBOT> what is the placement rate?")).toBe(
      "what is the placement rate?"
    );
  });

  it("trims whitespace around a bare mention", () => {
    expect(stripBotMention("  <@UBOT>   hello  ")).toBe("hello");
  });

  it("removes multiple occurrences of the mention", () => {
    expect(stripBotMention("<@UBOT> hi <@UBOT> there")).toBe("hi  there");
  });

  it("leaves text without the bot mention unchanged (aside from trimming)", () => {
    expect(stripBotMention("just a normal message")).toBe(
      "just a normal message"
    );
  });

  it("does not strip a different user's mention", () => {
    expect(stripBotMention("<@USOMEONE> hello")).toBe("<@USOMEONE> hello");
  });
});

describe("isUserDmMessage (DM subtype filtering)", () => {
  it("accepts a plain DM message from a real user", () => {
    expect(
      isUserDmMessage({
        channel_type: "im",
        user: "U1",
        text: "hi",
        ts: "1",
      })
    ).toBe(true);
  });

  it("rejects messages outside a DM (channel_type !== 'im')", () => {
    expect(
      isUserDmMessage({ channel_type: "channel", user: "U1", text: "hi" })
    ).toBe(false);
  });

  it("rejects any message with a subtype (edits, joins, deletions, etc.)", () => {
    expect(
      isUserDmMessage({
        channel_type: "im",
        subtype: "message_changed",
        user: "U1",
      })
    ).toBe(false);
    expect(
      isUserDmMessage({
        channel_type: "im",
        subtype: "channel_join",
        user: "U1",
      })
    ).toBe(false);
    expect(
      isUserDmMessage({ channel_type: "im", subtype: "bot_message" })
    ).toBe(false);
  });

  it("rejects messages with no user", () => {
    expect(isUserDmMessage({ channel_type: "im", text: "hi" })).toBe(false);
  });

  it("rejects the bot's own messages", () => {
    expect(
      isUserDmMessage({ channel_type: "im", user: "UBOT", text: "hi" })
    ).toBe(false);
  });
});

describe("normalizeMention", () => {
  it("maps an app_mention into a 'mention' envelope and strips the bot mention", () => {
    const envelope = normalizeMention({
      user: "U1",
      text: "<@UBOT> placements?",
      channel: "C123",
      ts: "1700.1",
    });
    expect(envelope).toEqual({
      type: "mention",
      userId: "U1",
      channelId: "C123",
      threadTs: "1700.1",
      text: "placements?",
      messageTs: "1700.1",
    });
  });

  it("uses thread_ts as threadTs when the mention is inside a thread", () => {
    const envelope = normalizeMention({
      user: "U1",
      text: "<@UBOT> follow-up",
      channel: "C123",
      ts: "1700.2",
      thread_ts: "1700.0",
    });
    expect(envelope.threadTs).toBe("1700.0");
    expect(envelope.messageTs).toBe("1700.2");
  });
});

describe("normalizeDmMessage", () => {
  it("maps a DM message into a 'dm' envelope", () => {
    const envelope = normalizeDmMessage({
      user: "U2",
      channel: "D999",
      text: "how many placements?",
      ts: "1800.1",
    });
    expect(envelope).toEqual({
      type: "dm",
      userId: "U2",
      channelId: "D999",
      threadTs: "1800.1",
      text: "how many placements?",
      messageTs: "1800.1",
    });
  });

  it("prefers thread_ts as threadTs when present, defaults text to empty string", () => {
    const envelope = normalizeDmMessage({
      user: "U2",
      channel: "D999",
      ts: "1800.2",
      thread_ts: "1800.0",
    });
    expect(envelope.threadTs).toBe("1800.0");
    expect(envelope.text).toBe("");
  });
});

describe("normalizeSlashCommand", () => {
  it("maps a /sentinel command into a 'slash_command' envelope using the posted message ts", () => {
    const envelope = normalizeSlashCommand(
      { user_id: "U1", channel_id: "C555", text: "show me revenue" },
      "1900.5"
    );
    expect(envelope).toEqual({
      type: "slash_command",
      userId: "U1",
      channelId: "C555",
      threadTs: "1900.5",
      text: "show me revenue",
      messageTs: "1900.5",
    });
  });

  it("falls back to a default prompt when the command text is empty", () => {
    const envelope = normalizeSlashCommand(
      { user_id: "U1", channel_id: "C555", text: "" },
      "1900.6"
    );
    expect(envelope.text).toBe("What can I help with?");
  });
});

// --------------------------------------------------------------------------
// Handler-level tests: register the Bolt handlers against a fake App, then
// invoke them with mocked Bolt contexts to assert routing/auth/ack/post
// behavior end-to-end (without opening a real socket).
// --------------------------------------------------------------------------

import { createSlackApp } from "../src/slack/socketClient.js";

type Registered = {
  event?: (args: any) => Promise<void>;
  message?: (args: any) => Promise<void>;
  command?: (args: any) => Promise<void>;
};

function buildAppHarness() {
  const registered: Registered = {};
  vi.doMock("@slack/bolt", () => {
    class FakeApp {
      event(_name: string, fn: (args: any) => Promise<void>) {
        registered.event = fn;
      }
      message(fn: (args: any) => Promise<void>) {
        registered.message = fn;
      }
      command(_name: string, fn: (args: any) => Promise<void>) {
        registered.command = fn;
      }
    }
    return {
      default: { App: FakeApp, LogLevel: { WARN: "warn" } },
    };
  });
  return registered;
}

describe("createSlackApp handler routing", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function loadWithFakeBolt() {
    const registered = buildAppHarness();
    // Re-apply the config + pino mocks for the freshly reset module graph.
    vi.doMock("../src/config.js", () => ({
      config: {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
        BOT_USER_ID: "UBOT",
        SENTINEL_OWNER_USER_ID: "UOWNER",
        SENTINEL_ACCESS_GROUP_HANDLE: "sentinel-access-group",
        ALLOWED_USER_IDS: ["U1", "U2"],
        LOG_LEVEL: "silent",
      },
    }));
    vi.doMock("pino", () => {
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
    const mod = await import("../src/slack/socketClient.js");
    // The reset module graph has a fresh (empty) access-group cache — seed the
    // members these routing tests treat as "allowed". U3 stays a non-member.
    const ag = await import("../src/slack/accessGroup.js");
    ag.__setAccessMembersForTests(["U1", "U2"]);
    return { registered, createSlackApp: mod.createSlackApp };
  }

  it("app_mention from an allowed user invokes the handler with a normalized envelope", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const client = {} as any;
    await registered.event!({
      event: {
        user: "U1",
        text: "<@UBOT> hi",
        channel: "C1",
        ts: "10.1",
      },
      client,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "mention",
        userId: "U1",
        channelId: "C1",
        text: "hi",
        threadTs: "10.1",
      }),
      client
    );
  });

  it("app_mention from a non-allowed user is ignored (auth gate)", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    await registered.event!({
      event: { user: "U3", text: "<@UBOT> hi", channel: "C1", ts: "10.1" },
      client: {} as any,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("DM from an allowed user invokes the handler with a 'dm' envelope", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    await registered.message!({
      message: {
        channel_type: "im",
        user: "U2",
        channel: "D1",
        text: "hello",
        ts: "20.1",
      },
      client: {} as any,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "dm", userId: "U2", text: "hello" }),
      expect.anything()
    );
  });

  it("DM with a subtype (e.g. message_changed) is ignored, not treated as a query", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    await registered.message!({
      message: {
        channel_type: "im",
        subtype: "message_changed",
        user: "U1",
        channel: "D1",
        text: "edited",
        ts: "20.2",
      },
      client: {} as any,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("the bot's own DM message is ignored", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    await registered.message!({
      message: {
        channel_type: "im",
        user: "UBOT",
        channel: "D1",
        text: "i am the bot",
        ts: "20.3",
      },
      client: {} as any,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("DM from a non-allowed user is ignored (auth gate)", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    await registered.message!({
      message: {
        channel_type: "im",
        user: "U3",
        channel: "D1",
        text: "let me in",
        ts: "20.4",
      },
      client: {} as any,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("/sentinel ACKs, posts a Processing message, and invokes the handler", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const ack = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn().mockResolvedValue({ ts: "30.1" });
    const client = { chat: { postMessage } } as any;

    await registered.command!({
      command: { user_id: "U1", channel_id: "C9", text: "revenue?" },
      ack,
      client,
    });

    expect(ack).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const postArg = postMessage.mock.calls[0][0];
    expect(postArg.channel).toBe("C9");
    expect(postArg.text).toContain("Processing");
    expect(postArg.text).toContain("revenue?");

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "slash_command",
        userId: "U1",
        channelId: "C9",
        threadTs: "30.1",
        text: "revenue?",
      }),
      client
    );
  });

  it("/sentinel from a non-allowed user ACKs, posts the denial, and does NOT invoke the handler", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const ack = vi.fn().mockResolvedValue(undefined);
    const postMessage = vi.fn().mockResolvedValue({ ts: "30.2" });
    const client = { chat: { postMessage } } as any;

    await registered.command!({
      command: { user_id: "U3", channel_id: "C9", text: "revenue?" },
      ack,
      client,
    });

    // Must still ACK (Slack requires it within 3s) ...
    expect(ack).toHaveBeenCalledTimes(1);
    // ... posts the access-denied reply (not the Processing message) ...
    expect(postMessage).toHaveBeenCalledTimes(1);
    const arg = postMessage.mock.calls[0][0];
    expect(arg.channel).toBe("C9");
    expect(arg.text).toContain("dont have access");
    expect(arg.text).not.toContain("Processing");
    // ... and never runs the expensive handler.
    expect(handler).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------------------
  // De-duplication: Slack re-delivers an event when a handler is slow (Claude
  // can take up to 120s). The same channel+ts must not be processed twice.
  // ------------------------------------------------------------------------

  it("a duplicate app_mention (same channel+ts) does not invoke the handler twice", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const client = {} as any;
    const event = { user: "U1", text: "<@UBOT> hi", channel: "C1", ts: "10.1" };

    await registered.event!({ event, client });
    await registered.event!({ event, client });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a duplicate DM (same channel+ts) does not invoke the handler twice", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const message = {
      channel_type: "im",
      user: "U2",
      channel: "D1",
      text: "hello",
      ts: "20.1",
    };

    await registered.message!({ message, client: {} as any });
    await registered.message!({ message, client: {} as any });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a duplicate /sentinel (same channel+ts) ACKs both times but invokes the handler once", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const ack = vi.fn().mockResolvedValue(undefined);
    // Slack re-delivers the same command; the posted message ts is stable, so
    // both deliveries derive the same dedupe key.
    const postMessage = vi.fn().mockResolvedValue({ ts: "30.1" });
    const client = { chat: { postMessage } } as any;
    const command = { user_id: "U1", channel_id: "C9", text: "revenue?" };

    await registered.command!({ command, ack, client });
    await registered.command!({ command, ack, client });

    // Slack must always be ACKed, even for a retry.
    expect(ack).toHaveBeenCalledTimes(2);
    // But the expensive work runs only once.
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the same ts in a different channel is NOT treated as a duplicate", async () => {
    const { registered, createSlackApp } = await loadWithFakeBolt();
    const handler = vi.fn().mockResolvedValue(undefined);
    createSlackApp(handler);

    const client = {} as any;
    await registered.event!({
      event: { user: "U1", text: "<@UBOT> hi", channel: "C1", ts: "10.1" },
      client,
    });
    await registered.event!({
      event: { user: "U1", text: "<@UBOT> hi", channel: "C2", ts: "10.1" },
      client,
    });

    expect(handler).toHaveBeenCalledTimes(2);
  });
});
