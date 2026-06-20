/**
 * Tiny TTL-based de-duplicator for Slack event delivery.
 *
 * Slack re-delivers an event when our handler is slow to respond (an agent run
 * can take up to 120s, which exceeds Slack's per-event timeout). Without
 * guarding, the same message gets processed multiple times → duplicate agent
 * runs and duplicate replies. This deduper records each key the first time it
 * is seen and rejects repeats within the TTL window, pruning expired keys so
 * it never grows unbounded.
 *
 * Side-effect-free and `now`-injectable for deterministic testing.
 */

export interface MessageDeduper {
  /** True the first time a key is seen (and records it); false within the TTL. */
  shouldProcess(key: string): boolean;
  /** Number of currently-tracked (non-expired as of the last access) keys. */
  size(): number;
}

export interface MessageDeduperOptions {
  /**
   * How long a key stays "seen" before it can be processed again. Defaults to
   * 10 minutes — comfortably longer than the 120s handler timeout plus Slack's
   * retry cadence, so genuine retries are always caught.
   */
  ttlMs?: number;
  /** Injectable clock (ms epoch) for testing. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export function createMessageDeduper(
  opts: MessageDeduperOptions = {}
): MessageDeduper {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;

  // key -> timestamp (ms) at which the key was first/last recorded.
  const seen = new Map<string, number>();

  function prune(currentMs: number): void {
    for (const [key, recordedMs] of seen) {
      if (currentMs - recordedMs >= ttlMs) {
        seen.delete(key);
      }
    }
  }

  return {
    shouldProcess(key: string): boolean {
      const currentMs = now();
      prune(currentMs);

      if (seen.has(key)) {
        return false;
      }

      seen.set(key, currentMs);
      return true;
    },
    size(): number {
      return seen.size;
    },
  };
}
