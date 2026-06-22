/**
 * Read-only query layer for the Sentinel dashboard.
 *
 * Every function takes a `Queryable` (Pick<Pool, "query">) rather than reaching
 * for the bot's in-process getPool() singleton, so the same code runs (a) in
 * tests against the per-worker test pool and (b) in the dashboard service
 * against its dedicated SELECT-only pool. All queries are parameterized and
 * LIMIT-capped — the caller can never request an unbounded scan.
 */

import type { Queryable } from "../state/db.js";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Clamp a caller-supplied limit into [1, MAX_LIMIT]; non-finite → default. */
function clampLimit(n: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
}

const sum = (xs: Array<number | null | undefined>): number =>
  xs.reduce<number>((a, x) => a + (x ?? 0), 0);

export type Sentiment = "positive" | "negative";

// ── Conversations feed ─────────────────────────────────────────────────────

export interface ConversationFilters {
  limit?: number;
  offset?: number;
  userId?: string;
  sentiment?: Sentiment;
}

export interface ConversationRow {
  traceId: string | null;
  channelId: string;
  replyTs: string;
  userId: string | null;
  displayName: string | null;
  question: string | null;
  answer: string | null;
  sentiment: Sentiment | null;
  createdAt: string;
}

interface ConversationDbRow {
  trace_id: string | null;
  channel_id: string;
  reply_ts: string;
  user_id: string | null;
  display_name: string | null;
  question: string | null;
  answer: string | null;
  sentiment: Sentiment | null;
  created_at: string;
}

/**
 * The readable Q&A feed. Backed by `bot_replies` (the spine that carries the
 * trace_id, so every row is drillable), LEFT-JOINed to `personas` for a human
 * name and to the latest `feedback` row for the 👍/👎 badge. Newest first.
 */
export async function listConversations(
  db: Queryable,
  opts: ConversationFilters = {}
): Promise<ConversationRow[]> {
  const limit = clampLimit(opts.limit);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const { rows } = await db.query<ConversationDbRow>(
    `SELECT b.trace_id, b.channel_id, b.reply_ts, b.user_id, p.display_name,
            b.question, b.answer, b.created_at,
            (SELECT f.sentiment FROM feedback f
              WHERE f.channel_id = b.channel_id AND f.reply_ts = b.reply_ts
              ORDER BY f.created_at DESC LIMIT 1) AS sentiment
     FROM bot_replies b
     LEFT JOIN personas p ON p.user_id = b.user_id
     WHERE ($1::text IS NULL OR b.user_id = $1)
       AND ($2::text IS NULL OR EXISTS (
             SELECT 1 FROM feedback f2
              WHERE f2.channel_id = b.channel_id AND f2.reply_ts = b.reply_ts
                AND f2.sentiment = $2))
     ORDER BY b.created_at DESC, b.reply_ts DESC
     LIMIT $3 OFFSET $4`,
    [opts.userId ?? null, opts.sentiment ?? null, limit, offset]
  );
  return rows.map((r) => ({
    traceId: r.trace_id,
    channelId: r.channel_id,
    replyTs: r.reply_ts,
    userId: r.user_id,
    displayName: r.display_name,
    question: r.question,
    answer: r.answer,
    sentiment: r.sentiment,
    createdAt: r.created_at,
  }));
}

// ── Trace drill-down ───────────────────────────────────────────────────────

export interface TraceCall {
  callId: string;
  operation: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  status: string;
  errorKind: string | null;
  numTurns: number | null;
  promptVersion: string | null;
  createdAt: string;
}

export interface TraceFeedback {
  sentiment: Sentiment;
  reaction: string;
  score: number;
  reactorUserId: string;
  createdAt: string;
}

export interface TraceTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number | null;
  promptVersion: string | null;
  latencyMs: number;
  callCount: number;
}

export interface TraceDetail {
  traceId: string;
  reply: {
    channelId: string;
    replyTs: string;
    userId: string | null;
    question: string | null;
    answer: string | null;
    createdAt: string;
  } | null;
  calls: TraceCall[];
  feedback: TraceFeedback[];
  totals: TraceTotals;
}

/**
 * Reconstruct one Q&A end-to-end from its trace_id: the reply header, every
 * LLM call in time order (reply + the extract/embed/etc. fan-out), the feedback
 * it received, and rolled-up totals. Returns null when the trace is unknown.
 */
export async function getTrace(db: Queryable, traceId: string): Promise<TraceDetail | null> {
  const [replyRes, callsRes, fbRes] = await Promise.all([
    db.query(
      `SELECT channel_id, reply_ts, user_id, question, answer, created_at
       FROM bot_replies WHERE trace_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [traceId]
    ),
    db.query(
      `SELECT call_id, operation, model, input_tokens, output_tokens, cost_usd,
              latency_ms, status, error_kind, num_turns, prompt_version, created_at
       FROM llm_calls WHERE trace_id = $1 ORDER BY created_at ASC, id ASC`,
      [traceId]
    ),
    db.query(
      `SELECT sentiment, reaction, score, reactor_user_id, created_at
       FROM feedback WHERE trace_id = $1 ORDER BY created_at ASC`,
      [traceId]
    ),
  ]);

  const replyRow = replyRes.rows[0] as Record<string, unknown> | undefined;
  if (!replyRow && callsRes.rows.length === 0) return null;

  const calls: TraceCall[] = callsRes.rows.map((c: Record<string, unknown>) => ({
    callId: c.call_id as string,
    operation: c.operation as string,
    model: c.model as string,
    inputTokens: (c.input_tokens as number | null) ?? null,
    outputTokens: (c.output_tokens as number | null) ?? null,
    costUsd: (c.cost_usd as number | null) ?? null,
    latencyMs: (c.latency_ms as number | null) ?? null,
    status: c.status as string,
    errorKind: (c.error_kind as string | null) ?? null,
    numTurns: (c.num_turns as number | null) ?? null,
    promptVersion: (c.prompt_version as string | null) ?? null,
    createdAt: c.created_at as string,
  }));

  const reply = calls.find((c) => c.operation === "reply");
  const totals: TraceTotals = {
    costUsd: sum(calls.map((c) => c.costUsd)),
    inputTokens: sum(calls.map((c) => c.inputTokens)),
    outputTokens: sum(calls.map((c) => c.outputTokens)),
    numTurns: reply?.numTurns ?? null,
    promptVersion: reply?.promptVersion ?? null,
    latencyMs: sum(calls.map((c) => c.latencyMs)),
    callCount: calls.length,
  };

  return {
    traceId,
    reply: replyRow
      ? {
          channelId: replyRow.channel_id as string,
          replyTs: replyRow.reply_ts as string,
          userId: (replyRow.user_id as string | null) ?? null,
          question: (replyRow.question as string | null) ?? null,
          answer: (replyRow.answer as string | null) ?? null,
          createdAt: replyRow.created_at as string,
        }
      : null,
    calls,
    feedback: fbRes.rows.map((f: Record<string, unknown>) => ({
      sentiment: f.sentiment as Sentiment,
      reaction: f.reaction as string,
      score: f.score as number,
      reactorUserId: f.reactor_user_id as string,
      createdAt: f.created_at as string,
    })),
    totals,
  };
}

// ── Negative-feedback (👎) triage queue ────────────────────────────────────

export interface NegativeFeedbackRow {
  feedbackId: number;
  traceId: string | null;
  channelId: string;
  replyTs: string;
  reactorUserId: string;
  question: string | null;
  answer: string | null;
  model: string | null;
  promptVersion: string | null;
  costUsd: number | null;
  createdAt: string;
}

/**
 * The 👎 triage queue: every negatively-rated reply, newest first, enriched
 * with the full Q&A text and the trace's cost / reply-model / prompt version so
 * the failing answer can be read and routed to a prompt fix or an eval case.
 */
export async function listNegativeFeedback(
  db: Queryable,
  opts: { limit?: number } = {}
): Promise<NegativeFeedbackRow[]> {
  const limit = clampLimit(opts.limit);
  const { rows } = await db.query(
    `SELECT f.id AS feedback_id, f.trace_id, f.channel_id, f.reply_ts,
            f.reactor_user_id, f.created_at, b.question, b.answer,
            agg.cost_usd, agg.model, agg.prompt_version
     FROM feedback f
     JOIN bot_replies b ON b.channel_id = f.channel_id AND b.reply_ts = f.reply_ts
     LEFT JOIN LATERAL (
       SELECT SUM(c.cost_usd) AS cost_usd,
              MAX(c.model) FILTER (WHERE c.operation = 'reply') AS model,
              MAX(c.prompt_version) FILTER (WHERE c.operation = 'reply') AS prompt_version
       FROM llm_calls c WHERE c.trace_id = f.trace_id
     ) agg ON true
     WHERE f.sentiment = 'negative'
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r: Record<string, unknown>) => ({
    feedbackId: r.feedback_id as number,
    traceId: (r.trace_id as string | null) ?? null,
    channelId: r.channel_id as string,
    replyTs: r.reply_ts as string,
    reactorUserId: r.reactor_user_id as string,
    question: (r.question as string | null) ?? null,
    answer: (r.answer as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    promptVersion: (r.prompt_version as string | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

// ── Summary (landing-page counters) ────────────────────────────────────────

export interface Summary {
  since: string | null;
  totalQueries: number;
  distinctUsers: number;
  positiveCount: number;
  negativeCount: number;
  positiveRatio: number | null;
  costUsd: number;
}

/**
 * Headline counters for the dashboard landing page, optionally windowed to
 * `since` (an ISO timestamp; ISO strings compare correctly lexicographically,
 * matching how created_at is stored).
 */
export async function getSummary(
  db: Queryable,
  opts: { since?: string } = {}
): Promise<Summary> {
  const since = opts.since ?? null;
  const [ql, fb, cost] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total, COUNT(DISTINCT user_id)::int AS users
       FROM query_log WHERE ($1::text IS NULL OR created_at >= $1)`,
      [since]
    ),
    db.query(
      `SELECT COUNT(*) FILTER (WHERE sentiment = 'positive')::int AS pos,
              COUNT(*) FILTER (WHERE sentiment = 'negative')::int AS neg
       FROM feedback WHERE ($1::text IS NULL OR created_at >= $1)`,
      [since]
    ),
    db.query(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS cost
       FROM llm_calls WHERE ($1::text IS NULL OR created_at >= $1)`,
      [since]
    ),
  ]);

  const total = (ql.rows[0] as { total: number }).total;
  const users = (ql.rows[0] as { users: number }).users;
  const pos = (fb.rows[0] as { pos: number }).pos;
  const neg = (fb.rows[0] as { neg: number }).neg;
  const costUsd = (cost.rows[0] as { cost: number }).cost;

  return {
    since,
    totalQueries: total,
    distinctUsers: users,
    positiveCount: pos,
    negativeCount: neg,
    positiveRatio: pos + neg > 0 ? pos / (pos + neg) : null,
    costUsd,
  };
}
