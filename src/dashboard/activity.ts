/**
 * Read-only "system activity" queries for the dashboard's health view — the
 * failure modes that stay green on every user-facing metric: a stuck ingest
 * cursor, a meet-bot that stopped joining, and the actual failed requests.
 * Self-contained SELECT SQL over a Queryable (config-free).
 */

import type { Queryable } from "../state/db.js";

function clampLimit(n: number | undefined, fallback = 50, max = 200): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

export interface IngestCursor {
  source: string;
  cursor: string;
  updatedAt: string;
}

/** High-water mark per ingest source (meet/gmail/slack). The UI derives age. */
export async function listIngestCursors(db: Queryable): Promise<IngestCursor[]> {
  const { rows } = await db.query(`SELECT source, cursor, updated_at FROM ingest_cursors ORDER BY source`);
  return rows.map((r: Record<string, unknown>) => ({
    source: r.source as string,
    cursor: r.cursor as string,
    updatedAt: r.updated_at as string,
  }));
}

export interface JoinedMeeting {
  eventId: string;
  joinedAt: number;
}

export async function recentJoinedMeetings(
  db: Queryable,
  opts: { limit?: number } = {}
): Promise<JoinedMeeting[]> {
  const { rows } = await db.query(
    `SELECT event_id, joined_at FROM joined_meetings ORDER BY joined_at DESC LIMIT $1`,
    [clampLimit(opts.limit)]
  );
  return rows.map((r: Record<string, unknown>) => ({
    eventId: r.event_id as string,
    joinedAt: Number(r.joined_at),
  }));
}

export interface FailedCall {
  callId: string;
  traceId: string;
  operation: string;
  errorKind: string | null;
  model: string;
  latencyMs: number | null;
  userId: string | null;
  question: string | null;
  createdAt: string;
}

/** Most recent errored LLM calls, with the user's question (if it was a reply). */
export async function recentFailedCalls(
  db: Queryable,
  opts: { limit?: number } = {}
): Promise<FailedCall[]> {
  const { rows } = await db.query(
    `SELECT c.call_id, c.trace_id, c.operation, c.error_kind, c.model, c.latency_ms,
            c.user_id, c.created_at, b.question
     FROM llm_calls c
     LEFT JOIN LATERAL (
       SELECT question FROM bot_replies b WHERE b.trace_id = c.trace_id AND b.question IS NOT NULL LIMIT 1
     ) b ON true
     WHERE c.status = 'error'
     ORDER BY c.created_at DESC
     LIMIT $1`,
    [clampLimit(opts.limit)]
  );
  return rows.map((r: Record<string, unknown>) => ({
    callId: r.call_id as string,
    traceId: r.trace_id as string,
    operation: r.operation as string,
    errorKind: (r.error_kind as string | null) ?? null,
    model: r.model as string,
    latencyMs: (r.latency_ms as number | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
    question: (r.question as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export interface Activity {
  cursors: IngestCursor[];
  meetings: JoinedMeeting[];
  failedCalls: FailedCall[];
}

/** Everything the health view needs in one round-trip. */
export async function getActivity(db: Queryable, opts: { limit?: number } = {}): Promise<Activity> {
  const [cursors, meetings, failedCalls] = await Promise.all([
    listIngestCursors(db),
    recentJoinedMeetings(db, opts),
    recentFailedCalls(db, opts),
  ]);
  return { cursors, meetings, failedCalls };
}
