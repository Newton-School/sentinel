import { describe, it, expect, vi, beforeEach } from "vitest";

let actionFn: ((args: any) => Promise<void>) | undefined;

function harness() {
  actionFn = undefined;
  vi.doMock("@slack/bolt", () => {
    class FakeApp {
      event() {}
      message() {}
      command() {}
      action(_constraint: unknown, fn: (args: any) => Promise<void>) {
        actionFn = fn;
      }
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

describe("createSlackApp feedback action routing", () => {
  beforeEach(() => vi.resetModules());

  async function load(withAction: boolean) {
    harness();
    const mod = await import("../src/slack/socketClient.js");
    const handler = vi.fn();
    mod.createSlackApp(vi.fn(), undefined, withAction ? handler : undefined);
    return { handler };
  }

  function payload(userId: string, actionId: string) {
    return {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { user: { id: userId }, channel: { id: "C1" }, message: { ts: "9.9", blocks: [{ type: "section" }] } },
      action: { action_id: actionId },
      client: {},
    };
  }

  it("does not register an action handler when none is provided", async () => {
    await load(false);
    expect(actionFn).toBeUndefined();
  });

  it("acks and routes an authorized user's 👍 click to the handler", async () => {
    const { handler } = await load(true);
    const p = payload("U1", "feedback_up");
    await actionFn!(p);
    expect(p.ack).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ reactorUserId: "U1", channelId: "C1", replyTs: "9.9", sentiment: "positive" });
  });

  it("acks but ignores an unauthorized user", async () => {
    const { handler } = await load(true);
    const p = payload("U99", "feedback_down");
    await actionFn!(p);
    expect(p.ack).toHaveBeenCalled(); // must always ack
    expect(handler).not.toHaveBeenCalled();
  });
});
