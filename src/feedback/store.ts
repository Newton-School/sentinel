/**
 * Feedback persistence. A posted bot reply is recorded in bot_replies (mapping
 * channel+ts → trace id, plus the Q&A text for later harvesting). A 👍/👎
 * reaction on a tracked reply is recorded in feedback and counted as an online
 * quality metric.
 */

import { getDb } from "../state/db.js";
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
export function recordReply(opts: RecordReplyInput): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO bot_replies (channel_id, reply_ts, trace_id, user_id, question, answer, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.channelId,
      opts.replyTs,
      opts.traceId ?? null,
      opts.userId ?? null,
      opts.question ?? null,
      opts.answer ?? null,
      new Date().toISOString()
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
export function recordFeedback(opts: RecordFeedbackInput): boolean {
  const sentiment = classifyReaction(opts.reaction);
  if (!sentiment) return false;

  const db = getDb();
  const reply = db
    .prepare(`SELECT trace_id FROM bot_replies WHERE channel_id = ? AND reply_ts = ?`)
    .get(opts.channelId, opts.replyTs) as { trace_id: string | null } | undefined;
  if (!reply) return false; // reaction was not on a tracked bot reply

  const res = db
    .prepare(
      `INSERT OR IGNORE INTO feedback
         (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      reply.trace_id ?? null,
      opts.channelId,
      opts.replyTs,
      opts.reactorUserId,
      opts.reaction,
      sentiment,
      sentiment === "positive" ? 1 : -1,
      opts.addedAtIso
    );

  if (res.changes > 0) recordFeedbackMetric(sentiment);
  return res.changes > 0;
}

/**
 * Records an explicit 👍/👎 button vote on a tracked bot reply. Unlike a
 * reaction (which can stack), a user has ONE button vote per reply — re-voting
 * (or switching) replaces it (reaction column fixed to 'button'). Returns true
 * when the reply is tracked; increments the online metric on each click.
 */
export function recordButtonFeedback(opts: {
  channelId: string;
  replyTs: string;
  reactorUserId: string;
  sentiment: "positive" | "negative";
  addedAtIso: string;
}): boolean {
  const db = getDb();
  const reply = db
    .prepare(`SELECT trace_id FROM bot_replies WHERE channel_id = ? AND reply_ts = ?`)
    .get(opts.channelId, opts.replyTs) as { trace_id: string | null } | undefined;
  if (!reply) return false;

  db.prepare(
    `INSERT OR REPLACE INTO feedback
       (trace_id, channel_id, reply_ts, reactor_user_id, reaction, sentiment, score, created_at)
     VALUES (?, ?, ?, ?, 'button', ?, ?, ?)`
  ).run(
    reply.trace_id ?? null,
    opts.channelId,
    opts.replyTs,
    opts.reactorUserId,
    opts.sentiment,
    opts.sentiment === "positive" ? 1 : -1,
    opts.addedAtIso
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
export function harvestNegativeFeedback(limit = 100): HarvestedCase[] {
  return getDb()
    .prepare(
      `SELECT f.id AS id, b.question AS question, b.answer AS answer
       FROM feedback f
       JOIN bot_replies b ON b.channel_id = f.channel_id AND b.reply_ts = f.reply_ts
       WHERE f.sentiment = 'negative' AND b.question IS NOT NULL AND b.answer IS NOT NULL
       ORDER BY f.created_at DESC
       LIMIT ?`
    )
    .all(limit) as HarvestedCase[];
}
