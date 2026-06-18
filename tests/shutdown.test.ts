import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGracefulShutdown, type ShutdownDeps } from "../src/shutdown.js";

describe("createGracefulShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeDeps(overrides: Partial<ShutdownDeps> = {}): {
    deps: ShutdownDeps;
    order: string[];
    mocks: {
      stopWatcher: ReturnType<typeof vi.fn>;
      stopSlackApp: ReturnType<typeof vi.fn>;
      closeHealthServer: ReturnType<typeof vi.fn>;
      closeDb: ReturnType<typeof vi.fn>;
      exit: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
    };
  } {
    const order: string[] = [];
    const stopWatcher = vi.fn(() => {
      order.push("stopWatcher");
    });
    const stopSlackApp = vi.fn(async () => {
      order.push("stopSlackApp");
    });
    const closeHealthServer = vi.fn(async () => {
      order.push("closeHealthServer");
    });
    const closeDb = vi.fn(() => {
      order.push("closeDb");
    });
    const exit = vi.fn(() => {
      order.push("exit");
    });
    const warn = vi.fn();

    const deps: ShutdownDeps = {
      stopWatcher,
      stopSlackApp,
      closeHealthServer,
      closeDb,
      getActiveRequests: () => 0,
      exit: exit as unknown as (code: number) => void,
      log: { info: vi.fn(), warn },
      drainTimeoutMs: 25000,
      drainPollMs: 250,
      ...overrides,
    };

    return {
      deps,
      order,
      mocks: { stopWatcher, stopSlackApp, closeHealthServer, closeDb, exit, warn },
    };
  }

  it("runs steps in order: stopWatcher -> stopSlackApp -> closeHealthServer -> closeDb -> exit(0)", async () => {
    const { deps, order, mocks } = makeDeps();
    const shutdown = createGracefulShutdown(deps);

    const p = shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    await p;

    expect(order).toEqual([
      "stopWatcher",
      "stopSlackApp",
      "closeHealthServer",
      "closeDb",
      "exit",
    ]);
    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.exit).toHaveBeenCalledTimes(1);
  });

  it("waits for in-flight requests to drain before exiting", async () => {
    let calls = 0;
    const getActiveRequests = vi.fn(() => {
      // 2, 2, then 0
      const seq = [2, 2, 0];
      const v = seq[Math.min(calls, seq.length - 1)];
      calls++;
      return v;
    });
    const { deps, mocks } = makeDeps({ getActiveRequests });
    const shutdown = createGracefulShutdown(deps);

    const p = shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    await p;

    // It should have polled until it observed 0 active requests.
    expect(getActiveRequests.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("times out the drain, logs a warning, and still exits(0)", async () => {
    const getActiveRequests = vi.fn(() => 2); // never drains
    const { deps, mocks } = makeDeps({
      getActiveRequests,
      drainTimeoutMs: 25000,
      drainPollMs: 250,
    });
    const shutdown = createGracefulShutdown(deps);

    const p = shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    await p;

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.exit).toHaveBeenCalledWith(0);
    expect(mocks.closeDb).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung stopSlackApp and still completes shutdown", async () => {
    // stopSlackApp that never resolves (hung Socket-Mode disconnect).
    const stopSlackApp = vi.fn(() => new Promise<void>(() => {}));
    const { deps, mocks } = makeDeps({
      stopSlackApp: stopSlackApp as unknown as () => Promise<void>,
      slackStopTimeoutMs: 10000,
    });
    const shutdown = createGracefulShutdown(deps);

    const p = shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    await p;

    // The hung stop timed out (warn), but close/db/exit still ran.
    expect(mocks.warn).toHaveBeenCalled();
    expect(mocks.closeHealthServer).toHaveBeenCalledTimes(1);
    expect(mocks.closeDb).toHaveBeenCalledTimes(1);
    expect(mocks.exit).toHaveBeenCalledWith(0);
  });

  it("is idempotent: a second signal does not re-run the sequence", async () => {
    const { deps, mocks } = makeDeps();
    const shutdown = createGracefulShutdown(deps);

    const p1 = shutdown("SIGTERM");
    const p2 = shutdown("SIGINT");
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);

    expect(mocks.stopWatcher).toHaveBeenCalledTimes(1);
    expect(mocks.stopSlackApp).toHaveBeenCalledTimes(1);
    expect(mocks.closeHealthServer).toHaveBeenCalledTimes(1);
    expect(mocks.closeDb).toHaveBeenCalledTimes(1);
    expect(mocks.exit).toHaveBeenCalledTimes(1);
  });
});
