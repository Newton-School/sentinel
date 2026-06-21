/**
 * Feedback persistence. A posted bot reply is recorded in bot_replies (mapping
 * channel+ts → trace id, plus the Q&A text for later harvesting). A 👍/👎
 * reaction on a tracked reply is recorded in feedback and counted as an online
 * quality metric.
 */

import { getPool } from "../state/db.js";
import { classifyReaction } from "./reactions.js";
import { recordFeedback as recordFeedbackMetric } from "../metrics/registry.js";

export interface RecordReplyInput {
  channelId: string;
  replyTs: string;
  traceId?: string;
  userId?: string;
  question?: string;
  answer?: string;
}

/** Remembers a bot reply so a later reaction on it can be attributed. */
export async function recordReply(opts: RecordReplyInput): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO bot_replies (channel_id, reply_ts, trace_id, user_id, question, answer, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (channel_id, reply_ts) DO UPDATE SET
       trace_id = EXCLUDED.trace_id,
       user_id = EXCLUDED.user_id,
       question = EXCLUDED.question,
       answer = EXCLUDED.answer,
       created_at = EXCLUDED.created_at`,
    [
      opts.channelId,
      opts.replyTs,
      opts.traceId ?? null,
      opts.userId ?? null,
      opts.question ?? null,
      opts.answer ?? null,
      new Date().toISOString(),
    ]
  );
}

export interface RecordFeedbackInput {
  channelId: string;
  replyTs: string;
  reactorUserId: string;
  reaction: string;
  addedAtIso: string;
}

/**
 * Records a reaction as feedback when (a) the emoji is a 👍/👎 signal and
 * (b) it lands on a tracked bot reply. Returns true only when a NEW feedback
 * row was written (deduped on channel+reply+reactor+reaction); only then is the
 * online metric incremented.
 */
export async function recordFeedback(opts: RecordFeedbackInput): Promise<boolean> {
  const sentiment = classifyReaction(opts.reaction);
  if (!sentiment) return false;

  const pool = getPool();
  const reply = (await pool.query(
    `SELECT trace_id FROM bot_replies WHERE channel_id = $1 AND reply_ts = $2`,
    [opts.channelId, opts.replyTs]
  )).rows[0] as { trace_id: string | null } | undefined;
  if (!reply) return false; // reaction was not on a tracked bot reply

  const res = await pool.query(
    `INSERT INTO feedback
       (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (channel_id, reply_ts, reactor_user_id, reaction) DO NOTHING`,
    [
      reply.trace_id ?? null,
      opts.channelId,
      opts.replyTs,
      opts.reactorUserId,
      opts.reaction,
      sentiment,
      sentiment === "positive" ? 1 : -1,
      opts.addedAtIso,
    ]
  );

  const changes = res.rowCount ?? 0;
  if (changes > 0) recordFeedbackMetric(sentiment);
  return changes > 0;
}

/**
 * Records an explicit 👍/👎 button vote on a tracked bot reply. Unlike a
 * reaction (which can stack), a user has ONE button vote per reply — re-voting
 * (or switching) replaces it (reaction column fixed to 'button'). Returns true
 * when the reply is tracked; increments the online metric on each click.
 */
export async function recordButtonFeedback(opts: {
  channelId: string;
  replyTs: string;
  reactorUserId: string;
  sentiment: "positive" | "negative";
  addedAtIso: string;
}): Promise<boolean> {
  const pool = getPool();
  const reply = (await pool.query(
    `SELECT trace_id FROM bot_replies WHERE channel_id = $1 AND reply_ts = $2`,
    [opts.channelId, opts.replyTs]
  )).rows[0] as { trace_id: string | null } | undefined;
  if (!reply) return false;

  await pool.query(
    `INSERT INTO feedback
       (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at)
     VALUES ($1, $2, $3, $4, 'button', $5, $6, $7)
     ON CONFLICT (channel_id, reply_ts, reactor_user_id, reaction) DO UPDATE SET
       trace_id = EXCLUDED.trace_id,
       sentiment = EXCLUDED.sentiment,
       score = EXCLUDED.score,
       created_at = EXCLUDED.created_at`,
    [
      reply.trace_id ?? null,
      opts.channelId,
      opts.replyTs,
      opts.reactorUserId,
      opts.sentiment,
      opts.sentiment === "positive" ? 1 : -1,
      opts.addedAtIso,
    ]
  );

  recordFeedbackMetric(opts.sentiment);
  return true;
}

export interface HarvestedCase {
  id: number;
  question: string;
  answer: string;
}

/**
 * Returns Q&A pairs for the most recently 👎'd replies — candidates to label
 * and add to the answer eval dataset (closing the loop from real feedback to
 * offline evals).
 */
export async function harvestNegativeFeedback(limit = 100): Promise<HarvestedCase[]> {
  const pool = getPool();
  return (await pool.query(
    `SELECT f.id AS id, b.question AS question, b.answer AS answer
     FROM feedback f
     JOIN bot_replies b ON b.channel_id = f.channel_id AND b.reply_ts = f.reply_ts
     WHERE f.sentiment = 'negative' AND b.question IS NOT NULL AND b.answer IS NOT NULL
     ORDER BY f.created_at DESC
     LIMIT $1`,
    [limit]
  )).rows as HarvestedCase[];
}
