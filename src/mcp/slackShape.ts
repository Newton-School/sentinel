/**
 * Pure, side-effect-free shaping helpers for the Slack-search MCP server.
 *
 * No `process.env` reads, no fetch, no server bootstrap — `slack.ts` performs
 * the authenticated API calls and passes the parsed response bodies through
 * these helpers, so they can be unit-tested in isolation.
 */

/** Convert a Slack `ts` ("seconds.micros" string) to an ISO-8601 timestamp. */
export function slackTsToIso(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString();
}

export interface SlackSearchMatch {
  text: string;
  username: string;
  ts: string;
  channel: { name: string; id: string };
  permalink: string;
}

export interface ShapedSearchMessage {
  channel: string;
  channelId: string;
  user: string;
  text: string;
  timestamp: string;
  permalink: string;
}

/** Shape search.messages matches; text is clamped to 500 chars. */
export function shapeSearchMatches(
  matches: SlackSearchMatch[]
): ShapedSearchMessage[] {
  return matches.map((m) => ({
    channel: m.channel.name,
    channelId: m.channel.id,
    user: m.username,
    text: m.text.slice(0, 500),
    timestamp: slackTsToIso(m.ts),
    permalink: m.permalink,
  }));
}

export interface SlackHistoryMessage {
  user?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
}

export interface ShapedHistoryMessage {
  user: string;
  text: string;
  timestamp: string;
  ts: string;
  hasThread: boolean;
  replyCount: number;
}

/**
 * Shape conversations.history messages. A message is flagged `hasThread` only
 * when it carries a `thread_ts` AND a positive `reply_count` (so a reply that
 * merely belongs to a thread isn't itself counted as a thread parent). Missing
 * `user` (e.g. bot messages) falls back to "bot".
 */
export function shapeChannelHistory(
  messages: SlackHistoryMessage[]
): ShapedHistoryMessage[] {
  return messages.map((m) => ({
    user: m.user ?? "bot",
    text: m.text.slice(0, 500),
    timestamp: slackTsToIso(m.ts),
    ts: m.ts,
    hasThread: !!m.thread_ts && m.reply_count !== undefined && m.reply_count > 0,
    replyCount: m.reply_count ?? 0,
  }));
}

export interface SlackReplyMessage {
  user?: string;
  text: string;
  ts: string;
}

export interface ShapedReplyMessage {
  user: string;
  text: string;
  timestamp: string;
}

/** Shape conversations.replies messages; text clamped to 500 chars. */
export function shapeThreadReplies(
  messages: SlackReplyMessage[]
): ShapedReplyMessage[] {
  return messages.map((m) => ({
    user: m.user ?? "bot",
    text: m.text.slice(0, 500),
    timestamp: slackTsToIso(m.ts),
  }));
}
