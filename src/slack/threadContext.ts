import type { WebClient } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import type { ThreadMessage } from "../types/contracts.js";
import { paginate } from "../mcp/paginate.js";

const log = createLogger("thread-context");

// Slack returns at most 50 messages per page here; we follow the cursor and
// accumulate up to this many messages so long threads aren't silently cut off.
const PAGE_SIZE = 50;
const MAX_MESSAGES = 200;

export async function fetchThreadContext(
  client: WebClient,
  channelId: string,
  threadTs: string
): Promise<ThreadMessage[]> {
  try {
    const { items: replies, truncated } = await paginate({
      maxItems: MAX_MESSAGES,
      fetchPage: async (cursor) => {
        const args: {
          channel: string;
          ts: string;
          limit: number;
          cursor?: string;
        } = { channel: channelId, ts: threadTs, limit: PAGE_SIZE };
        if (cursor) args.cursor = cursor;

        const result = await client.conversations.replies(args);
        // Slack repeats the parent message as the first entry on EVERY page of
        // a thread; drop it from every page so we accumulate replies only.
        const messages = (result.messages ?? []).filter(
          (msg) => msg.ts !== threadTs
        );
        return {
          items: messages,
          next: result.response_metadata?.next_cursor,
        };
      },
    });

    if (truncated) {
      log.warn(
        { channelId, threadTs, maxMessages: MAX_MESSAGES },
        "Thread context truncated at max messages — older replies omitted"
      );
    }

    if (replies.length === 0) {
      return [];
    }

    return replies.map((msg) => ({
      userId: msg.user ?? "unknown",
      text: msg.text ?? "",
      ts: msg.ts ?? "",
    }));
  } catch (err) {
    log.warn({ err, channelId, threadTs }, "Failed to fetch thread context");
    return [];
  }
}
