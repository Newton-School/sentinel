import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";

// watcher.ts imports ../config.js, whose top-level loadConfig() calls
// process.exit(1) on invalid env. Mock it so importing the module is safe and
// deterministic. The Google credentials are only read by startMeetWatcher()
// (not exercised here) — runOnce takes the calendar client directly.
// DATABASE_URL points at the per-worker Postgres test DB so the watcher's
// persistent join dedup (joined_meetings table via joinStore) is exercised
// for real.
vi.mock("../src/config.js", () => ({
  config: {
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    GOOGLE_REFRESH_TOKEN: "grefresh",
    DATABASE_URL: process.env.DATABASE_URL,
    PG_POOL_MAX: 5,
    LOG_LEVEL: "silent",
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

// The watcher's join dedup is persisted in Postgres via joinStore. Open the
// per-worker test pool before any runOnce/markJoined touches it.
const { initDb, closeDb } = await import("../src/state/db.js");
await initDb();
const { resetTestDb } = await import("./helpers/pgTest.js");

const {
  runOnce,
  buildJoinerArgs,
  mapCalendarEvents,
  purgeOldJoinedIds,
  resetActiveJoinerCount,
} = await import("../src/meet-bot/watcher.js");

// The watcher's join dedup is now persisted in Postgres via joinStore. Import
// the store so tests can seed/inspect joined IDs the same way the watcher does.
const { markJoined, getJoinedIds } = await import(
  "../src/meet-bot/joinStore.js"
);

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

// Helper: is an event ID currently recorded as joined within the 4h TTL window?
async function isJoined(id: string): Promise<boolean> {
  return (await getJoinedIds(Date.now() - FOUR_HOURS_MS)).has(id);
}

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
  beforeEach(async () => {
    vi.clearAllMocks();
    await resetTestDb();
    // Reset the module-level active-joiner counter; without freeing slots the
    // default cap of 1 would block spawns in later tests of this suite.
    resetActiveJoinerCount();
    delete process.env.MAX_CONCURRENT_JOINERS;
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
    // Lift the concurrency cap so both eligible events spawn in one poll; the
    // backpressure cap behavior itself is covered in meetWatcherConcurrency.
    process.env.MAX_CONCURRENT_JOINERS = "2";
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
    // The joined ID is persisted in Postgres (survives restarts).
    expect(await isJoined("evt-dedup")).toBe(true);

    // Same event returned again on the next poll — must NOT spawn again.
    await runOnce(client);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("skips an event already recorded as joined in the persistent store", async () => {
    // Simulate a prior process having joined this event (e.g. before a restart):
    // seed the store directly, then poll. The watcher must NOT spawn again.
    await markJoined("evt-prejoined", Date.now());

    const { client } = makeCalendar([
      eligibleRawEvent("evt-prejoined", "aaa-bbbb-ccc"),
    ]);
    await runOnce(client);
    expect(spawnMock).not.toHaveBeenCalled();
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

describe("purgeOldJoinedIds (TTL purge, now persisted in Postgres)", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  // getJoinedIds uses the same cutoff as the watcher's purge; query at the
  // exact `now` used in the purge so the TTL boundary is asserted precisely.
  async function joinedWithinTtl(id: string, now: number): Promise<boolean> {
    return (await getJoinedIds(now - FOUR_HOURS_MS)).has(id);
  }

  it("purges entries older than the 4h TTL but retains recent ones", async () => {
    const now = Date.now();
    await markJoined("old", now - FOUR_HOURS_MS - 1);
    await markJoined("recent", now - 1000);

    await purgeOldJoinedIds(now);

    expect(await joinedWithinTtl("old", now)).toBe(false);
    expect(await joinedWithinTtl("recent", now)).toBe(true);
  });

  it("retains an entry exactly at the TTL boundary (not strictly older)", async () => {
    const now = Date.now();
    await markJoined("boundary", now - FOUR_HOURS_MS);
    await purgeOldJoinedIds(now);
    // cutoff = now - TTL; entry kept when joined_at >= cutoff
    expect(await joinedWithinTtl("boundary", now)).toBe(true);
  });

  it("defaults to Date.now() when no time is provided", async () => {
    await markJoined("ancient", 0);
    await purgeOldJoinedIds();
    expect(await joinedWithinTtl("ancient", Date.now())).toBe(false);
  });
});

afterAll(async () => {
  await closeDb();
});

describe("buildJoinerArgs is re-exported from watcher", () => {
  it("is a function", () => {
    expect(typeof buildJoinerArgs).toBe("function");
  });
});
