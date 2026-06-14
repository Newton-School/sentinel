import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock pino (meetWatcherSpawn.test.ts pattern).
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

// The watcher builds a googleapis OAuth2 + gmail client at startup; keep it inert.
vi.mock("googleapis", () => ({
  google: {
    auth: {
      OAuth2: class {
        setCredentials(): void {}
      },
    },
    gmail: vi.fn(() => ({ tag: "gmail-client" })),
  },
}));

const FIVE_MIN_MS = 5 * 60 * 1000;

const FULL_CREDS = {
  GOOGLE_CLIENT_ID: "gid",
  GOOGLE_CLIENT_SECRET: "gsecret",
  GOOGLE_REFRESH_TOKEN: "grefresh",
  OPENAI_API_KEY: "sk-openai-test",
};

async function loadWatcher(cfg: Record<string, unknown>) {
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent", ...cfg },
  }));
  const runMeetIngest = vi.fn(async () => {});
  const runGmailIngest = vi.fn(async () => {});
  vi.doMock("../src/memory/meetIngest.js", () => ({ runMeetIngest }));
  vi.doMock("../src/memory/gmailIngest.js", () => ({
    runGmailIngest,
    resolveInternalDomains: () => ["newtonschool.co"],
  }));
  const createMeetClient = vi.fn(() => ({ tag: "meet-client" }));
  vi.doMock("../src/google/meetClient.js", () => ({ createMeetClient }));

  const mod = await import("../src/memory/ingestWatcher.js");
  return { mod, runMeetIngest, runGmailIngest, createMeetClient };
}

describe("startIngestWatcher", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    delete process.env.MEMORY_INGEST_MEET;
    delete process.env.MEMORY_INGEST_GMAIL;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.MEMORY_INGEST_MEET;
    delete process.env.MEMORY_INGEST_GMAIL;
  });

  it("gates on Google credentials: warns and returns a no-op stop, no interval", async () => {
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher({
      OPENAI_API_KEY: "sk-openai-test",
    });

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS * 3);

    expect(runMeetIngest).not.toHaveBeenCalled();
    expect(runGmailIngest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => stop()).not.toThrow();
  });

  it("gates on the OpenAI key: warns and returns a no-op stop, no interval", async () => {
    const { mod, runMeetIngest } = await loadWatcher({
      GOOGLE_CLIENT_ID: "gid",
      GOOGLE_CLIENT_SECRET: "gsecret",
      GOOGLE_REFRESH_TOKEN: "grefresh",
    });

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(runMeetIngest).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("fires once immediately, then every 5 minutes; stop() halts the loop", async () => {
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher(FULL_CREDS);

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0); // flush the fire-once run
    expect(runMeetIngest).toHaveBeenCalledTimes(1);
    expect(runGmailIngest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(runMeetIngest).toHaveBeenCalledTimes(2);
    expect(runGmailIngest).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS * 4);
    expect(runMeetIngest).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs Meet before Gmail and passes the shared deps through", async () => {
    const { mod, runMeetIngest, runGmailIngest, createMeetClient } =
      await loadWatcher(FULL_CREDS);

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0);

    expect(createMeetClient).toHaveBeenCalledTimes(1);
    expect(createMeetClient).toHaveBeenCalledWith({
      clientId: "gid",
      clientSecret: "gsecret",
      refreshToken: "grefresh",
    });

    const meetOrder = runMeetIngest.mock.invocationCallOrder[0];
    const gmailOrder = runGmailIngest.mock.invocationCallOrder[0];
    expect(meetOrder).toBeLessThan(gmailOrder);

    const meetDeps = runMeetIngest.mock.calls[0][0] as Record<string, unknown>;
    expect(meetDeps.meetClient).toEqual({ tag: "meet-client" });
    expect(meetDeps.apiKey).toBe("sk-openai-test");

    const gmailDeps = runGmailIngest.mock.calls[0][0] as Record<string, unknown>;
    expect(gmailDeps.apiKey).toBe("sk-openai-test");
    expect(gmailDeps.internalDomains).toEqual(["newtonschool.co"]);
    expect(gmailDeps.gmail).toBeTruthy();

    stop();
  });

  it("a Meet ingest failure does not block the Gmail ingest (and vice versa)", async () => {
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher(FULL_CREDS);
    runMeetIngest.mockRejectedValue(new Error("meet boom"));
    runGmailIngest.mockRejectedValueOnce(new Error("gmail boom"));

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0);
    expect(runMeetIngest).toHaveBeenCalledTimes(1);
    expect(runGmailIngest).toHaveBeenCalledTimes(1);

    // Next tick still runs both — failures never kill the loop.
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(runMeetIngest).toHaveBeenCalledTimes(2);
    expect(runGmailIngest).toHaveBeenCalledTimes(2);

    stop();
  });

  it("kill switch MEMORY_INGEST_MEET=0 disables only the Meet source", async () => {
    process.env.MEMORY_INGEST_MEET = "0";
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher(FULL_CREDS);

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0);

    expect(runMeetIngest).not.toHaveBeenCalled();
    expect(runGmailIngest).toHaveBeenCalledTimes(1);
    stop();
  });

  it("kill switch MEMORY_INGEST_GMAIL=0 disables only the Gmail source", async () => {
    process.env.MEMORY_INGEST_GMAIL = "0";
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher(FULL_CREDS);

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0);

    expect(runMeetIngest).toHaveBeenCalledTimes(1);
    expect(runGmailIngest).not.toHaveBeenCalled();
    stop();
  });

  it("overlap guard: a still-running tick makes the next tick skip, then recovers", async () => {
    const { mod, runMeetIngest, runGmailIngest } = await loadWatcher(FULL_CREDS);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runMeetIngest.mockImplementationOnce(() => gate);

    const stop = mod.startIngestWatcher();
    await vi.advanceTimersByTimeAsync(0);
    // First tick is stuck inside runMeetIngest.
    expect(runMeetIngest).toHaveBeenCalledTimes(1);
    expect(runGmailIngest).not.toHaveBeenCalled();

    // 5 minutes later the previous tick is still running → skipped entirely.
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(runMeetIngest).toHaveBeenCalledTimes(1);
    expect(runGmailIngest).not.toHaveBeenCalled();

    // Release the stuck run; it finishes its Gmail half.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(runGmailIngest).toHaveBeenCalledTimes(1);

    // The next interval tick runs normally again.
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(runMeetIngest).toHaveBeenCalledTimes(2);
    expect(runGmailIngest).toHaveBeenCalledTimes(2);

    stop();
  });
});
