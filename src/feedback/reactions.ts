/**
 * Maps a Slack reaction emoji name to a feedback sentiment. Only an explicit
 * thumbs-up/down (and check marks) count as quality signal; everything else is
 * ignored so casual reactions don't pollute the data.
 */

export type Sentiment = "positive" | "negative";

const POSITIVE = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark"]);
const NEGATIVE = new Set(["-1", "thumbsdown"]);

/** Returns the sentiment for a reaction name, or null if it isn't feedback. */
export function classifyReaction(name: string): Sentiment | null {
  // Slack appends skin-tone modifiers like "thumbsup::skin-tone-3".
  const base = name.split("::")[0];
  if (POSITIVE.has(base)) return "positive";
  if (NEGATIVE.has(base)) return "negative";
  return null;
}
