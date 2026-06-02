/**
 * Side-effect-free graceful-shutdown orchestration.
 *
 * Extracted from `index.ts` (which runs `main()` at import and therefore can't
 * be imported in a unit test) so the ordering/drain/idempotency logic is
 * testable in isolation with injected dependencies.
 */

export interface ShutdownDeps {
  /** Stop the Meet watcher poll loop (clearInterval). Does NOT kill already-detached joiner subprocesses. */
  stopWatcher: () => void;
  /** Stop accepting new Slack events (`app.stop()`). */
  stopSlackApp: () => Promise<void>;
  /** Close the health HTTP server. */
  closeHealthServer: () => Promise<void> | void;
  /** Close the SQLite database. */
  closeDb: () => void;
  /** Current count of in-flight requests; polled during drain. */
  getActiveRequests: () => number;
  /** Process exit, injectable for tests. */
  exit: (code: number) => void;
  log: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void };
  /** Hard cap on draining in-flight requests. Default 25s (under K8s 30s grace). */
  drainTimeoutMs?: number;
  /** How often to re-check active request count while draining. Default 250ms. */
  drainPollMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 25_000;
const DEFAULT_DRAIN_POLL_MS = 250;

/**
 * Build an idempotent async shutdown handler. The returned function may be
 * registered for both SIGINT and SIGTERM; a second invocation while a shutdown
 * is already in progress is a no-op (it awaits the in-flight shutdown).
 */
export function createGracefulShutdown(
  deps: ShutdownDeps
): (signal: string) => Promise<void> {
  const drainTimeoutMs = deps.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const drainPollMs = deps.drainPollMs ?? DEFAULT_DRAIN_POLL_MS;

  let inProgress: Promise<void> | null = null;

  async function drain(): Promise<void> {
    const deadline = Date.now() + drainTimeoutMs;
    while (deps.getActiveRequests() > 0) {
      if (Date.now() >= deadline) {
        deps.log.warn(
          { activeRequests: deps.getActiveRequests(), drainTimeoutMs },
          "Drain timeout reached — proceeding with shutdown anyway"
        );
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, drainPollMs));
    }
  }

  async function run(signal: string): Promise<void> {
    deps.log.info({ signal }, "Received signal, starting graceful shutdown");

    // 1. Stop the Meet watcher poll loop (no new joiner spawns).
    //    Detached joiner subprocesses are intentionally left running.
    deps.stopWatcher();

    // 2. Stop accepting new Slack events.
    await deps.stopSlackApp();

    // 3. Drain in-flight requests (bounded by drainTimeoutMs).
    await drain();

    // 4. Close the health HTTP server.
    await deps.closeHealthServer();

    // 5. Close the database.
    deps.closeDb();

    deps.log.info({ signal }, "Graceful shutdown complete");

    // 6. Exit.
    deps.exit(0);
  }

  return function shutdown(signal: string): Promise<void> {
    if (inProgress) return inProgress;
    inProgress = run(signal);
    return inProgress;
  };
}
