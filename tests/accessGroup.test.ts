import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
vi.mock("../src/config.js", () => ({
  config: {
    SLACK_BOT_TOKEN: "xoxb-test",
    SENTINEL_ACCESS_GROUP_HANDLE: "sentinel-access-group",
    LOG_LEVEL: "silent",
  },
}));

import {
  refreshAccessGroupMembers,
  isAccessGroupMember,
  getAccessGroupMembers,
  denialMessage,
  startAccessGroupWatcher,
  __setAccessMembersForTests,
} from "../src/slack/accessGroup.js";

/** A minimal mock of the Slack WebClient's usergroups.list. */
function mockWeb(usergroups: unknown[], opts: { throws?: boolean } = {}) {
  const list = vi.fn(async () => {
    if (opts.throws) throw new Error("missing_scope");
    return { ok: true, usergroups };
  });
  return { client: { usergroups: { list } }, list };
}

beforeEach(() => __setAccessMembersForTests([]));

describe("refreshAccessGroupMembers", () => {
  it("resolves the configured handle and populates the member set", async () => {
    const { client, list } = mockWeb([
      { handle: "other-group", users: ["U9"] },
      { handle: "sentinel-access-group", users: ["U1", "U2", "U3"] },
    ]);
    const r = await refreshAccessGroupMembers(client as never);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(3);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ include_users: true }));
    expect(isAccessGroupMember("U1")).toBe(true);
    expect(isAccessGroupMember("U3")).toBe(true);
    expect(isAccessGroupMember("U9")).toBe(false);
    expect([...getAccessGroupMembers()].sort()).toEqual(["U1", "U2", "U3"]);
  });

  it("returns ok:false and KEEPS the prior cache when the handle is not found", async () => {
    __setAccessMembersForTests(["U1", "U2"]);
    const { client } = mockWeb([{ handle: "some-other-group", users: ["U9"] }]);
    const r = await refreshAccessGroupMembers(client as never);
    expect(r.ok).toBe(false);
    // prior cache preserved (stale ≥ empty)
    expect(isAccessGroupMember("U1")).toBe(true);
    expect(isAccessGroupMember("U9")).toBe(false);
  });

  it("returns ok:false and KEEPS the prior cache when the API throws (e.g. missing scope)", async () => {
    __setAccessMembersForTests(["U1"]);
    const { client } = mockWeb([], { throws: true });
    const r = await refreshAccessGroupMembers(client as never);
    expect(r.ok).toBe(false);
    expect(isAccessGroupMember("U1")).toBe(true);
  });

  it("treats a group with no users as an empty membership", async () => {
    const { client } = mockWeb([{ handle: "sentinel-access-group" }]);
    const r = await refreshAccessGroupMembers(client as never);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(isAccessGroupMember("U1")).toBe(false);
  });
});

describe("denialMessage", () => {
  it("renders a real mention when an owner id is given", () => {
    expect(denialMessage("U05EUC842KD")).toBe(
      "you dont have access to me, connect <@U05EUC842KD> for this"
    );
  });
  it("falls back to literal @theOG when no owner id", () => {
    expect(denialMessage()).toBe("you dont have access to me, connect @theOG for this");
  });
});

describe("startAccessGroupWatcher", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes immediately on start and again each interval; stop() halts it", async () => {
    vi.useFakeTimers();
    const { client, list } = mockWeb([{ handle: "sentinel-access-group", users: ["U1"] }]);
    const stop = await startAccessGroupWatcher(1000, client as never);
    expect(list).toHaveBeenCalledTimes(1); // immediate, awaited
    expect(isAccessGroupMember("U1")).toBe(true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(list).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(list).toHaveBeenCalledTimes(2); // no more after stop
  });
});
