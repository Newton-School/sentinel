import { describe, it, expect, vi, beforeEach } from "vitest";

const events: Record<string, (args: any) => Promise<void>> = {};

function harness() {
  vi.doMock("@slack/bolt", () => {
    class FakeApp {
      event(name: string, fn: (args: any) => Promise<void>) {
        events[name] = fn;
      }
      message() {}
      command() {}
    }
    return { default: { App: FakeApp, LogLevel: { WARN: "warn" } } };
  });
  vi.doMock("../src/config.js", () => ({
    config: {
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      BOT_USER_ID: "UBOT",
      ALLOWED_USER_IDS: ["U1", "U2"],
      LOG_LEVEL: "silent",
    },
  }));
  vi.doMock("pino", () => {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
    const pino = () => logger;
    pino.stdTimeFunctions = { isoTime: () => "" };
    return { default: pino };
  });
}

describe("createSlackApp reaction routing", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const k of Object.keys(events)) delete events[k];
  });

  async function load(withReaction: boolean) {
    harness();
    const mod = await import("../src/slack/socketClient.js");
    // Seed the fresh access-group cache so U1 is "allowed" (others are not).
    const ag = await import("../src/slack/accessGroup.js");
    ag.__setAccessMembersForTests(["U1", "U2"]);
    const reactionHandler = vi.fn();
    mod.createSlackApp(vi.fn(), withReaction ? reactionHandler : undefined);
    return { reactionHandler };
  }

  it("does not register reaction_added when no handler is provided", async () => {
    await load(false);
    expect(events["reaction_added"]).toBeUndefined();
  });

  it("routes an authorized user's message reaction to the handler", async () => {
    const { reactionHandler } = await load(true);
    await events["reaction_added"]({ event: { user: "U1", reaction: "-1", item: { type: "message", channel: "C1", ts: "9.9" } } });
    expect(reactionHandler).toHaveBeenCalledWith({ reactorUserId: "U1", channelId: "C1", itemTs: "9.9", reaction: "-1" });
  });

  it("ignores the bot's own reactions and unauthorized users", async () => {
    const { reactionHandler } = await load(true);
    await events["reaction_added"]({ event: { user: "UBOT", reaction: "-1", item: { type: "message", channel: "C1", ts: "9.9" } } });
    await events["reaction_added"]({ event: { user: "U99", reaction: "-1", item: { type: "message", channel: "C1", ts: "9.9" } } });
    expect(reactionHandler).not.toHaveBeenCalled();
  });

  it("ignores reactions on non-message items", async () => {
    const { reactionHandler } = await load(true);
    await events["reaction_added"]({ event: { user: "U1", reaction: "-1", item: { type: "file", channel: "C1", ts: "9.9" } } });
    expect(reactionHandler).not.toHaveBeenCalled();
  });
});
