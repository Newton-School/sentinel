/**
 * Slack Block Kit builders for the feedback UI: render the bot's answer as
 * section blocks (chunked under Slack's 3000-char-per-text limit) followed by
 * 👍/👎 buttons, and an "acknowledged" variant that swaps the buttons for a
 * thank-you note once the user has voted.
 *
 * Buttons (interactive components) are preferred over reactions: they need only
 * Slack Interactivity (which Socket Mode supports out of the box), not the
 * reactions:read scope, and they're visible/affordant on every reply.
 */

/** Slack's hard limit for a single text object in a section block. */
const SECTION_TEXT_LIMIT = 3000;
/** Chunk target, with headroom under the limit. */
const CHUNK_TARGET = 2900;

/** Minimal Block Kit shapes we emit (kept local to avoid a Slack types dep). */
export type Block = Record<string, unknown> & { type: string };

/**
 * Splits mrkdwn text into chunks ≤ `max` chars, preferring newline boundaries
 * and hard-splitting any single line that is itself too long.
 */
export function chunkMrkdwn(text: string, max = CHUNK_TARGET): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single line longer than the limit must be hard-split.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > max) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function feedbackButton(actionId: string, label: string, traceId: string): Block {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label, emoji: true },
    value: traceId,
  };
}

/**
 * The answer as section blocks + an actions block with 👍/👎 buttons. The
 * trace id rides on each button's `value` so a click is attributable even
 * without a DB lookup.
 */
export function buildReplyBlocks(mrkdwn: string, traceId: string): Block[] {
  const blocks: Block[] = chunkMrkdwn(mrkdwn).map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk.slice(0, SECTION_TEXT_LIMIT) },
  }));
  blocks.push({
    type: "actions",
    block_id: "sentinel_feedback",
    elements: [
      feedbackButton("feedback_up", "👍 Helpful", traceId),
      feedbackButton("feedback_down", "👎 Not helpful", traceId),
    ],
  });
  return blocks;
}

/**
 * Replaces the feedback actions block with a context line acknowledging the
 * vote — so the buttons disappear after one click and the user gets confirmation.
 */
export function acknowledgedBlocks(
  blocks: Block[],
  sentiment: "positive" | "negative",
  userId: string
): Block[] {
  const emoji = sentiment === "positive" ? "👍" : "👎";
  const kept = blocks.filter((b) => b.type !== "actions");
  kept.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${emoji} Thanks for the feedback, <@${userId}>.` }],
  });
  return kept;
}
