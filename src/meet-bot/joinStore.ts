import { getDb } from "../state/db.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("meet-join-store");

/**
 * Persistent join-dedup store for the Meet watcher (table `joined_meetings`).
 *
 * Previously the watcher tracked joined event IDs in an in-memory `Map`, which
 * was lost on restart — causing it to re-join still-in-progress meetings and
 * spawn a second Chromium. Persisting the IDs in SQLite makes dedup survive
 * restarts while keeping the same TTL semantics (callers pass the cutoff).
 */

/**
 * Records that an event has been joined. Race-safe: a duplicate insert for the
 * same `eventId` updates `joined_at` instead of throwing on the PK conflict.
 */
export function markJoined(eventId: string, nowMs: number = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO joined_meetings (event_id, joined_at)
       VALUES (?, ?)
       ON CONFLICT(event_id) DO UPDATE SET joined_at = excluded.joined_at`
    )
    .run(eventId, nowMs);
  log.debug({ eventId, joinedAt: nowMs }, "Marked meeting joined");
}

/**
 * Returns the set of event IDs joined at or after `cutoffMs` (the TTL window).
 * Rows older than the cutoff are excluded so expired entries no longer dedup.
 */
export function getJoinedIds(cutoffMs: number): Set<string> {
  const rows = getDb()
    .prepare("SELECT event_id FROM joined_meetings WHERE joined_at >= ?")
    .all(cutoffMs) as Array<{ event_id: string }>;
  return new Set(rows.map((r) => r.event_id));
}

/** Deletes join-dedup rows strictly older than `cutoffMs` (TTL purge). */
export function purgeJoined(cutoffMs: number): void {
  const info = getDb()
    .prepare("DELETE FROM joined_meetings WHERE joined_at < ?")
    .run(cutoffMs);
  if (info.changes > 0) {
    log.debug({ purged: info.changes, cutoffMs }, "Purged expired join entries");
  }
}

/** Test helper: clears all join-dedup rows. */
export function clearJoined(): void {
  getDb().prepare("DELETE FROM joined_meetings").run();
}
