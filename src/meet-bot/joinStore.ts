import { getPool, type Queryable } from "../state/db.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("meet-join-store");

/**
 * Persistent join-dedup store for the Meet watcher (table `joined_meetings`).
 *
 * Previously the watcher tracked joined event IDs in an in-memory `Map`, which
 * was lost on restart — causing it to re-join still-in-progress meetings and
 * spawn a second Chromium. Persisting the IDs in Postgres makes dedup survive
 * restarts while keeping the same TTL semantics (callers pass the cutoff).
 */

/**
 * Records that an event has been joined. Race-safe: a duplicate insert for the
 * same `eventId` updates `joined_at` instead of throwing on the PK conflict.
 */
export async function markJoined(eventId: string, nowMs: number = Date.now()): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO joined_meetings (event_id, joined_at)
     VALUES ($1, $2)
     ON CONFLICT (event_id) DO UPDATE SET joined_at = EXCLUDED.joined_at`,
    [eventId, nowMs]
  );
  log.debug({ eventId, joinedAt: nowMs }, "Marked meeting joined");
}

/**
 * Returns the set of event IDs joined at or after `cutoffMs` (the TTL window).
 * Rows older than the cutoff are excluded so expired entries no longer dedup.
 */
export async function getJoinedIds(cutoffMs: number): Promise<Set<string>> {
  const pool = getPool();
  const rows = (await pool.query(
    "SELECT event_id FROM joined_meetings WHERE joined_at >= $1",
    [cutoffMs]
  )).rows as Array<{ event_id: string }>;
  return new Set(rows.map((r) => r.event_id));
}

/** Deletes join-dedup rows strictly older than `cutoffMs` (TTL purge). */
export async function purgeJoined(cutoffMs: number): Promise<void> {
  const pool = getPool();
  const r = await pool.query(
    "DELETE FROM joined_meetings WHERE joined_at < $1",
    [cutoffMs]
  );
  const purged = r.rowCount ?? 0;
  if (purged > 0) {
    log.debug({ purged, cutoffMs }, "Purged expired join entries");
  }
}

/** Test helper: clears all join-dedup rows. */
export async function clearJoined(): Promise<void> {
  const pool = getPool();
  await pool.query("DELETE FROM joined_meetings");
}
