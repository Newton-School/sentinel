import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

// watcher.ts imports ../config.js, whose top-level loadConfig() calls
// process.exit(1) on invalid env. Mock it so importing the module is safe and
// deterministic. The Google credentials are only read by startMeetWatcher()
// (not exercised here) — runOnce takes the calendar client directly.
vi.mock("../src/config.js", () => ({
  config: {
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    GOOGLE_REFRESH_TOKEN: "grefresh",
  },
}));

// Silence pino structured logging.
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

// A controllable fake detached child process.
class FakeChild extends EventEmitter {
  pid = 4242;
  unref = vi.fn();
}

const spawnMock = vi.fn(() => new FakeChild());
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// Avoid touching the filesystem when spawnJoiner opens its per-spawn log file.
const mkdirSyncMock = vi.fn();
const openSyncMock = vi.fn(() => 7);
vi.mock("node:fs", () => ({
  mkdirSync: mkdirSyncMock,
  openSync: openSyncMock,
}));

const {
  runOnce,
  buildJoinerArgs,
  mapCalendarEvents,
  purgeOldJoinedIds,
  joinedAt,
  resetJoinedAt,
} = await import("../src/meet-bot/watcher.js");

// Build a fake googleapis calendar client whose events.list returns a fixed set.
function makeCalendar(items: unknown[]) {
  const list = vi.fn(async () => ({ data: { items } }));
  return {
    client: { events: { list } } as unknown as Parameters<typeof runOnce>[0],
    list,
  };
}

// An event that filterEventsToJoin will accept: starts in ~1 min, ends in ~30.
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

describe("mapCalendarEvents", () => {
  it("maps raw Google events to CalendarEventLite and drops events without an id", () => {
    const raw = [
      {
        id: "e1",
        summary: "S",
        description: "D",
        location: "L",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
        conferenceData: {
          entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" }],
        },
        start: { dateTime: "2026-04-21T10:00:00Z" },
        end: { dateTime: "2026-04-21T10:30:00Z" },
      },
      { summary: "no id — dropped" },
    ];
    const lite = mapCalendarEvents(raw);
    expect(lite).toHaveLength(1);
    expect(lite[0]).toMatchObject({
      id: "e1",
      summary: "S",
      description: "D",
      location: "L",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
    });
    expect(lite[0].conferenceData?.entryPoints?.[0]).toEqual({
      entryPointType: "video",
      uri: "https://meet.google.com/xyz-abcd-efg",
    });
    expect(lite[0].start.dateTime).toBe("2026-04-21T10:00:00Z");
    expect(lite[0].end.dateTime).toBe("2026-04-21T10:30:00Z");
  });

  it("coerces null fields to undefined", () => {
    const lite = mapCalendarEvents([
      {
        id: "e2",
        summary: null,
        description: null,
        location: null,
        hangoutLink: null,
        conferenceData: null,
        start: { dateTime: null, date: null },
        end: { dateTime: null, date: null },
      },
    ]);
    expect(lite[0].summary).toBeUndefined();
    expect(lite[0].hangoutLink).toBeUndefined();
    expect(lite[0].conferenceData).toBeUndefined();
    expect(lite[0].start.dateTime).toBeUndefined();
  });

  it("returns an empty array for null/missing items", () => {
    expect(mapCalendarEvents([])).toEqual([]);
  });
});

describe("runOnce poll loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetJoinedAt();
  });

  it("queries the calendar with timeMin/timeMax/singleEvents/orderBy", async () => {
    const { client, list } = makeCalendar([]);
    await runOnce(client);
    expect(list).toHaveBeenCalledTimes(1);
    const arg = list.mock.calls[0][0];
    expect(arg.calendarId).toBe("primary");
    expect(typeof arg.timeMin).toBe("string");
    expect(typeof arg.timeMax).toBe("string");
    expect(arg.singleEvents).toBe(true);
    expect(arg.orderBy).toBe("startTime");
    // timeMax must be after timeMin (look-ahead window)
    expect(new Date(arg.timeMax).getTime()).toBeGreaterThan(
      new Date(arg.timeMin).getTime()
    );
  });

  it("spawns a joiner for each eligible event", async () => {
    const { client } = makeCalendar([
      eligibleRawEvent("evt-1", "aaa-bbbb-ccc"),
      eligibleRawEvent("evt-2", "ddd-eeee-fff"),
    ]);
    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    // Each spawn carries the right Meet URL in its argv.
    const urls = spawnMock.mock.calls.map((c) => (c[1] as string[]).find((a) => a.startsWith("https://")));
    expect(urls.sort()).toEqual([
      "https://meet.google.com/aaa-bbbb-ccc",
      "https://meet.google.com/ddd-eeee-fff",
    ]);
  });

  it("records joined event IDs so they are skipped on the next poll (dedup)", async () => {
    const { client } = makeCalendar([eligibleRawEvent("evt-dedup", "aaa-bbbb-ccc")]);

    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(joinedAt.has("evt-dedup")).toBe(true);

    // Same event returned again on the next poll — must NOT spawn again.
    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not spawn anything when there are no eligible events", async () => {
    const farFuture = {
      id: "far",
      summary: "Later",
      hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
      start: { dateTime: new Date(Date.now() + 60 * 60_000).toISOString() },
      end: { dateTime: new Date(Date.now() + 90 * 60_000).toISOString() },
    };
    const { client } = makeCalendar([farFuture]);
    await runOnce(client);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("swallows calendar errors without throwing", async () => {
    const client = {
      events: { list: vi.fn(async () => { throw new Error("API down"); }) },
    } as unknown as Parameters<typeof runOnce>[0];
    await expect(runOnce(client)).resolves.toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("spawns with the dev (tsx) argv built by buildJoinerArgs", async () => {
    const { client } = makeCalendar([eligibleRawEvent("evt-x", "aaa-bbbb-ccc")]);
    await runOnce(client);
    const [command, args] = spawnMock.mock.calls[0];
    // First arg is the command, second is the args array.
    const argv = [command, ...(args as string[])];
    expect(argv).toContain("--stay-mode");
    expect(argv[argv.indexOf("--stay-mode") + 1]).toBe("stay-until-end");
    expect(argv).toContain("--duration");
  });
});

describe("purgeOldJoinedIds (TTL purge)", () => {
  beforeEach(() => {
    resetJoinedAt();
  });

  it("purges entries older than the 4h TTL but retains recent ones", () => {
    const now = Date.now();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    joinedAt.set("old", now - FOUR_HOURS - 1);
    joinedAt.set("recent", now - 1000);

    purgeOldJoinedIds(now);

    expect(joinedAt.has("old")).toBe(false);
    expect(joinedAt.has("recent")).toBe(true);
  });

  it("retains an entry exactly at the TTL boundary (not strictly older)", () => {
    const now = Date.now();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    joinedAt.set("boundary", now - FOUR_HOURS);
    purgeOldJoinedIds(now);
    // cutoff = now - TTL; entry kept when ts >= cutoff
    expect(joinedAt.has("boundary")).toBe(true);
  });

  it("defaults to Date.now() when no time is provided", () => {
    joinedAt.set("ancient", 0);
    purgeOldJoinedIds();
    expect(joinedAt.has("ancient")).toBe(false);
  });
});

describe("buildJoinerArgs is re-exported from watcher", () => {
  it("is a function", () => {
    expect(typeof buildJoinerArgs).toBe("function");
  });
});
