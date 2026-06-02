/**
 * Read-time confidence decay for persona traits.
 *
 * Stored trait confidence only ever grows (see `upsertTrait`), so without
 * decay stale interests would linger forever and bloat the system prompt.
 * Rather than mutating stored rows on a schedule, we apply an exponential
 * half-life decay at *read* time based on how long ago the trait was last
 * reinforced (`updated_at`). Reinforcing a trait refreshes `updated_at`, which
 * naturally reverses the decay on the next read.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Half-life of trait confidence, in days. After this many days without
 * reinforcement a trait's reported confidence is halved.
 */
export const DECAY_HALF_LIFE_DAYS = 30;

/**
 * Returns `confidence` faded by an exponential half-life decay based on the
 * age of `updatedAt` relative to `now`.
 *
 * - No decay when `updatedAt` is (about) `now`.
 * - Halves every `DECAY_HALF_LIFE_DAYS` of staleness.
 * - Never returns below 0.
 * - A future `updatedAt` (negative age) is clamped to "no decay".
 *
 * Pure function: it does not read or mutate any stored state.
 */
export function decayedConfidence(
  confidence: number,
  updatedAt: string,
  now: Date
): number {
  if (confidence <= 0) return 0;

  const updatedMs = new Date(updatedAt).getTime();
  // A malformed timestamp should not silently zero out a trait; treat it as
  // fresh (no decay) rather than fully decayed.
  if (Number.isNaN(updatedMs)) return Math.max(0, confidence);

  const ageDays = (now.getTime() - updatedMs) / DAY_MS;
  if (ageDays <= 0) return Math.max(0, confidence);

  const factor = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS);
  const decayed = confidence * factor;
  return decayed > 0 ? decayed : 0;
}
