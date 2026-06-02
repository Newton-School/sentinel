import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// Mirror the mocking setup of meetWatcherSpawn.test.ts so importing the watcher
// is safe/deterministic and the SQLite-backed join store runs against :memory:.
vi.mock("../src/config.js", () => ({
  config: {
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    GOOGLE_REFRESH_TOKEN: "grefresh",
    SQLITE_DB_PATH: ":memory:",
    LOG_LEVEL: "silent",
  },
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

// A controllable fake detached child process. Tests drive its lifecycle by
// emitting "exit" to free a concurrency slot, exactly like a real joiner exit.
class FakeChild extends EventEmitter {
  pid = 4242;
  unref = vi.fn();
}

// Hand each spawn its own FakeChild and remember them so tests can emit "exit".
const spawnedChildren: FakeChild[] = [];
const spawnMock = vi.fn(() => {
  const child = new FakeChild();
  spawnedChildren.push(child);
  return child;
});
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const mkdirSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 7);
vi.mock("node:fs", () => ({
  mkdirSync: mkdirSyncMock,
  openSync: openSyncMock,
}));

const {
  runOnce,
  canSpawnJoiner,
  activeJoinerCount,
  resetActiveJoinerCount,
  resetJoinedAt,
} = await import("../src/meet-bot/watcher.js");

const { getJoinedIds } = await import("../src/meet-bot/joinStore.js");

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

function isJoined(id: string): boolean {
  return getJoinedIds(Date.now() - FOUR_HOURS_MS).has(id);
}

function makeCalendar(items: unknown[]) {
  const list = vi.fn(async () => ({ data: { items } }));
  return {
    client: { events: { list } } as unknown as Parameters<typeof runOnce>[0],
    list,
  };
}

function eligibleRawEvent(id: string, code: string) {
  const start = new Date(Date.now() + 60_000).toISOString();
  const end = new Date(Date.now() + 30 * 60_000).toISOString();
  return {
    id,
    summary: `Meeting ${id}`,
    hangoutLink: `https://meet.google.com/${code}`,
    start: { dateTime: start },
    end: { dateTime: end },
  };
}

describe("canSpawnJoiner", () => {
  it("is true when active < cap", () => {
    expect(canSpawnJoiner(0, 1)).toBe(true);
    expect(canSpawnJoiner(2, 3)).toBe(true);
  });

  it("is false when active >= cap", () => {
    expect(canSpawnJoiner(1, 1)).toBe(false);
    expect(canSpawnJoiner(3, 3)).toBe(false);
    expect(canSpawnJoiner(5, 3)).toBe(false);
  });
});

describe("active joiner count tracking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnedChildren.length = 0;
    resetJoinedAt();
    resetActiveJoinerCount();
  });

  it("starts at zero", () => {
    expect(activeJoinerCount()).toBe(0);
  });

  it("increments on spawn and decrements when the child exits", async () => {
    const { client } = makeCalendar([eligibleRawEvent("evt-1", "aaa-bbbb-ccc")]);
    await runOnce(client);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activeJoinerCount()).toBe(1);

    // Simulate the detached joiner process exiting — slot must free up.
    spawnedChildren[0].emit("exit", 0, null);
    expect(activeJoinerCount()).toBe(0);
  });
});

describe("runOnce concurrency cap (shared Chrome profile → default 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    spawnedChildren.length = 0;
    resetJoinedAt();
    resetActiveJoinerCount();
    delete process.env.MAX_CONCURRENT_JOINERS;
  });

  it("with two eligible events and cap=1, spawns only ONE and marks only that one", async () => {
    const { client } = makeCalendar([
      eligibleRawEvent("evt-1", "aaa-bbbb-ccc"),
      eligibleRawEvent("evt-2", "ddd-eeee-fff"),
    ]);

    await runOnce(client);

    // Only one joiner spawned; the second event was deferred (backpressure).
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activeJoinerCount()).toBe(1);

    // Exactly one of the two events was marked joined; the deferred one is NOT
    // marked, so it can be retried on the next poll.
    const joinedCount = [isJoined("evt-1"), isJoined("evt-2")].filter(Boolean)
      .length;
    expect(joinedCount).toBe(1);
  });

  it("retries the deferred event on a later poll once a slot frees (child exit)", async () => {
    const { client } = makeCalendar([
      eligibleRawEvent("evt-1", "aaa-bbbb-ccc"),
      eligibleRawEvent("evt-2", "ddd-eeee-fff"),
    ]);

    // First poll: cap reached after the first spawn, second is deferred.
    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const firstUrl = (spawnMock.mock.calls[0][1] as string[]).find((a) =>
      a.startsWith("https://")
    );

    // Free the slot by exiting the active joiner.
    spawnedChildren[0].emit("exit", 0, null);
    expect(activeJoinerCount()).toBe(0);

    // Second poll: the still-unmarked deferred event should now spawn.
    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    const secondUrl = (spawnMock.mock.calls[1][1] as string[]).find((a) =>
      a.startsWith("https://")
    );

    // Both meet URLs end up covered across the two polls; no duplicate spawn of
    // the same already-joined event.
    expect([firstUrl, secondUrl].sort()).toEqual([
      "https://meet.google.com/aaa-bbbb-ccc",
      "https://meet.google.com/ddd-eeee-fff",
    ]);
    expect(isJoined("evt-1")).toBe(true);
    expect(isJoined("evt-2")).toBe(true);
  });

  it("does not spawn a second joiner while one is still active", async () => {
    const first = makeCalendar([eligibleRawEvent("evt-1", "aaa-bbbb-ccc")]);
    await runOnce(first.client);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(activeJoinerCount()).toBe(1);

    // A different eligible event arrives while the first joiner is still alive.
    const second = makeCalendar([eligibleRawEvent("evt-2", "ddd-eeee-fff")]);
    await runOnce(second.client);

    // Still capped — no second spawn, and the new event is NOT marked joined.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(isJoined("evt-2")).toBe(false);
  });

  it("honors MAX_CONCURRENT_JOINERS override (cap=2 spawns both)", async () => {
    process.env.MAX_CONCURRENT_JOINERS = "2";
    const { client } = makeCalendar([
      eligibleRawEvent("evt-1", "aaa-bbbb-ccc"),
      eligibleRawEvent("evt-2", "ddd-eeee-fff"),
    ]);

    await runOnce(client);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(activeJoinerCount()).toBe(2);
    expect(isJoined("evt-1")).toBe(true);
    expect(isJoined("evt-2")).toBe(true);
  });
});
