import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (joinStore.test.ts pattern).
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

const NOW = new Date("2026-06-11T12:00:00Z");
const now = () => NOW;
const INIT_CURSOR = "2026-06-10T12:00:00.000Z"; // NOW − 24h

function record(id: string, endTime: string | undefined) {
  return {
    name: `conferenceRecords/${id}`,
    startTime: "2026-06-10T10:00:00Z",
    endTime,
    space: "spaces/space1",
  };
}

function extractedFact(overrides: Record<string, unknown> = {}) {
  return {
    text: "Launch moved to July 15 per leadership decision.",
    category: "decision",
    entities: ["launch"],
    confidence: 0.95,
    evidence_quote: "ship July 15",
    sensitivity: "normal",
    ...overrides,
  };
}

function fakeMeetClient(overrides: Record<string, unknown> = {}) {
  return {
    listConferenceRecords: vi.fn(async () => []),
    listTranscripts: vi.fn(async () => []),
    listTranscriptEntries: vi.fn(async () => []),
    resolveParticipantName: vi.fn(async (name: string) =>
      name.endsWith("p1") ? "Alice" : "Bob"
    ),
    ...overrides,
  };
}

/**
 * Loads meetIngest with mocked config (in-memory DB), extractor, and
 * anthropicClient. Returns the module plus the mocks and DB helpers.
 */
async function loadMeetIngest(opts: {
  extractFacts?: ReturnType<typeof vi.fn>;
  extractJson?: ReturnType<typeof vi.fn>;
} = {}) {
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  const extractFacts = opts.extractFacts ?? vi.fn(async () => []);
  const extractJson = opts.extractJson ?? vi.fn(async () => null);
  vi.doMock("../src/memory/extractor.js", () => ({ extractFacts }));
  vi.doMock("../src/llm/anthropicClient.js", () => ({ extractJson }));

  const mod = await import("../src/memory/meetIngest.js");
  const { getDb } = await import("../src/state/db.js");
  const sql = await import("../src/memory/memorySql.js");
  return { runMeetIngest: mod.runMeetIngest, extractFacts, extractJson, getDb, sql };
}

describe("runMeetIngest", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    closeDb();
  });

  it("initializes the cursor to now−24h (ISO), saves it, and filters on it", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient();

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(sql.getCursor(getDb(), "meet")).toBe(INIT_CURSOR);
    expect(meetClient.listConferenceRecords).toHaveBeenCalledWith(
      `end_time>"${INIT_CURSOR}"`
    );
  });

  it("reuses an existing cursor instead of re-initializing", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    sql.setCursor(getDb(), "meet", "2026-06-11T00:00:00.000Z");
    const meetClient = fakeMeetClient();

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(meetClient.listConferenceRecords).toHaveBeenCalledWith(
      'end_time>"2026-06-11T00:00:00.000Z"'
    );
  });

  it("grace window: skips conferences that ended < 15 min ago or have no endTime", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("fresh", "2026-06-11T11:50:00Z"), // ended 10 min ago — too fresh
        record("open", undefined), // still running
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(meetClient.listTranscripts).not.toHaveBeenCalled();
    expect(sql.isIngested(getDb(), "meet:fresh")).toBe(false);
    expect(sql.isIngested(getDb(), "meet:open")).toBe(false);
    // Cursor stays at the freshly-initialized value.
    expect(sql.getCursor(getDb(), "meet")).toBe(INIT_CURSOR);
  });

  it("processes a conference ended exactly 15 min ago (boundary included)", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("boundary", "2026-06-11T11:45:00Z"), // exactly now − 15min
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(meetClient.listTranscripts).toHaveBeenCalledTimes(1);
    expect(sql.isIngested(getDb(), "meet:boundary")).toBe(true);
  });

  it("processes at most 3 conferences per tick, deferring the rest", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("r1", "2026-06-10T13:00:00Z"),
        record("r2", "2026-06-10T14:00:00Z"),
        record("r3", "2026-06-10T15:00:00Z"),
        record("r4", "2026-06-10T16:00:00Z"),
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(meetClient.listTranscripts).toHaveBeenCalledTimes(3);
    expect(sql.isIngested(getDb(), "meet:r1")).toBe(true);
    expect(sql.isIngested(getDb(), "meet:r2")).toBe(true);
    expect(sql.isIngested(getDb(), "meet:r3")).toBe(true);
    // The 4th is deferred — unmarked, and the cursor stops before it so the
    // next tick's filter re-lists it.
    expect(sql.isIngested(getDb(), "meet:r4")).toBe(false);
    expect(sql.getCursor(getDb(), "meet")).toBe("2026-06-10T15:00:00Z");
  });

  it("marks a transcript-less conference ingested (never retried forever), no facts", async () => {
    const { runMeetIngest, extractFacts, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("silent", "2026-06-10T13:00:00Z"),
      ]),
      listTranscripts: vi.fn(async () => []),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(sql.isIngested(getDb(), "meet:silent")).toBe(true);
    expect(extractFacts).not.toHaveBeenCalled();
    expect(sql.getCursor(getDb(), "meet")).toBe("2026-06-10T13:00:00Z");
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("happy path: inserts speaker-attributed facts with meeting provenance plus a summary fact", async () => {
    const extractFacts = vi.fn(async () => [extractedFact()]);
    const extractJson = vi.fn(async () => ({
      summary: "Agreed to ship the launch on July 15; Priya owns pricing rollout.",
    }));
    const { runMeetIngest, getDb, sql } = await loadMeetIngest({
      extractFacts,
      extractJson,
    });

    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("rec1", "2026-06-10T13:00:00Z"),
      ]),
      listTranscripts: vi.fn(async () => [
        { name: "conferenceRecords/rec1/transcripts/t1", state: "ENDED" },
      ]),
      listTranscriptEntries: vi.fn(async () => [
        {
          participant: "conferenceRecords/rec1/participants/p1",
          text: "We will ship July 15.",
        },
        {
          participant: "conferenceRecords/rec1/participants/p2",
          text: "Priya owns the pricing rollout.",
        },
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    // The extractor saw the speaker-attributed transcript chunk.
    expect(extractFacts).toHaveBeenCalledTimes(1);
    const input = extractFacts.mock.calls[0][0] as Record<string, unknown>;
    expect(input.sourceType).toBe("meeting");
    expect(input.sourceLabel).toBe("Meeting: space1 2026-06-10");
    expect(input.content).toBe(
      "Alice: We will ship July 15.\nBob: Priya owns the pricing rollout."
    );
    expect(input.apiKey).toBe("sk-test");

    const rows = getDb()
      .prepare(
        `SELECT text, category, source_type, source_ref, source_label, confidence, asserted_at
         FROM memories ORDER BY id`
      )
      .all() as Array<{
      text: string;
      category: string;
      source_type: string;
      source_ref: string;
      source_label: string;
      confidence: number;
      asserted_at: string;
    }>;

    expect(rows).toHaveLength(2);
    // Extracted fact: confidence capped at 0.7, meeting provenance.
    expect(rows[0].text).toBe("Launch moved to July 15 per leadership decision.");
    expect(rows[0].source_type).toBe("meeting");
    expect(rows[0].source_ref).toBe("conferenceRecords/rec1");
    expect(rows[0].confidence).toBe(0.7);
    expect(rows[0].asserted_at).toBe("2026-06-10T13:00:00Z");
    // Summary fact (one per conference) at confidence 0.6.
    expect(rows[1].category).toBe("summary");
    expect(rows[1].text).toBe(
      "Meeting 2026-06-10: Agreed to ship the launch on July 15; Priya owns pricing rollout."
    );
    expect(rows[1].confidence).toBe(0.6);
    expect(rows[1].source_ref).toBe("conferenceRecords/rec1");
    expect(rows[1].asserted_at).toBe("2026-06-10T13:00:00Z");

    // Summary call went through extractJson directly with a {summary} schema
    // over the concatenated fact texts (≤4000 chars).
    expect(extractJson).toHaveBeenCalledTimes(1);
    const summaryArgs = extractJson.mock.calls[0][0] as Record<string, unknown>;
    const schema = summaryArgs.schema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["summary"]);
    expect(summaryArgs.user).toContain(
      "Launch moved to July 15 per leadership decision."
    );
    expect((summaryArgs.user as string).length).toBeLessThanOrEqual(4000);

    expect(sql.isIngested(getDb(), "meet:rec1")).toBe(true);
    expect(sql.getCursor(getDb(), "meet")).toBe("2026-06-10T13:00:00Z");
  });

  it("skips the summary when extraction produced zero facts (still marks + advances)", async () => {
    const extractFacts = vi.fn(async () => []);
    const extractJson = vi.fn(async () => ({ summary: "should never be called" }));
    const { runMeetIngest, getDb, sql } = await loadMeetIngest({
      extractFacts,
      extractJson,
    });

    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("rec1", "2026-06-10T13:00:00Z"),
      ]),
      listTranscripts: vi.fn(async () => [
        { name: "conferenceRecords/rec1/transcripts/t1" },
      ]),
      listTranscriptEntries: vi.fn(async () => [
        { participant: "conferenceRecords/rec1/participants/p1", text: "hello" },
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });

    expect(extractJson).not.toHaveBeenCalled();
    const count = getDb()
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };
    expect(count.n).toBe(0);
    expect(sql.isIngested(getDb(), "meet:rec1")).toBe(true);
    expect(sql.getCursor(getDb(), "meet")).toBe("2026-06-10T13:00:00Z");
  });

  it("mid-conference failure: conference NOT marked, cursor NOT advanced, later records not skipped past", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("boom", "2026-06-10T13:00:00Z"),
        record("after", "2026-06-10T14:00:00Z"),
      ]),
      listTranscripts: vi.fn(async () => [
        { name: "conferenceRecords/boom/transcripts/t1" },
      ]),
      listTranscriptEntries: vi.fn(async () => {
        throw new Error("Meet API exploded");
      }),
    });

    await expect(
      runMeetIngest({ meetClient, apiKey: "sk-test", now })
    ).resolves.toBeUndefined();

    expect(sql.isIngested(getDb(), "meet:boom")).toBe(false);
    expect(sql.getCursor(getDb(), "meet")).toBe(INIT_CURSOR);
    // Processing stops at the failed conference so the cursor can never jump
    // over it — the later record was not processed either.
    expect(sql.isIngested(getDb(), "meet:after")).toBe(false);
    expect(meetClient.listTranscripts).toHaveBeenCalledTimes(1);
  });

  it("second run dedups: an already-ingested conference is not re-extracted", async () => {
    const extractFacts = vi.fn(async () => [extractedFact()]);
    const extractJson = vi.fn(async () => ({ summary: "Shipped it." }));
    const { runMeetIngest, getDb, sql } = await loadMeetIngest({
      extractFacts,
      extractJson,
    });

    const meetClient = fakeMeetClient({
      listConferenceRecords: vi.fn(async () => [
        record("rec1", "2026-06-10T13:00:00Z"),
      ]),
      listTranscripts: vi.fn(async () => [
        { name: "conferenceRecords/rec1/transcripts/t1" },
      ]),
      listTranscriptEntries: vi.fn(async () => [
        { participant: "conferenceRecords/rec1/participants/p1", text: "ship it" },
      ]),
    });

    await runMeetIngest({ meetClient, apiKey: "sk-test", now });
    expect(extractFacts).toHaveBeenCalledTimes(1);

    // Same record listed again (e.g. same-second cursor overlap) → deduped.
    await runMeetIngest({ meetClient, apiKey: "sk-test", now });
    expect(extractFacts).toHaveBeenCalledTimes(1);
    expect(meetClient.listTranscripts).toHaveBeenCalledTimes(1);
    expect(sql.getCursor(getDb(), "meet")).toBe("2026-06-10T13:00:00Z");
  });

  it("purges ingest-dedup rows older than 14 days once per run", async () => {
    const { runMeetIngest, getDb, sql } = await loadMeetIngest();
    const db = getDb();
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    sql.markIngested(db, "meet:ancient", NOW.getTime() - fourteenDaysMs - 1);
    sql.markIngested(db, "meet:recent", NOW.getTime() - 1000);

    await runMeetIngest({ meetClient: fakeMeetClient(), apiKey: "sk-test", now });

    expect(sql.isIngested(db, "meet:ancient")).toBe(false);
    expect(sql.isIngested(db, "meet:recent")).toBe(true);
  });
});
