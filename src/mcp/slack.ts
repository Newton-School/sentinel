#!/usr/bin/env node

/**
 * Slack Search MCP Server — exposes Slack search and channel reading as MCP tools.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Requires a user token (xoxp-) with search:read scope for search.messages,
 * and channels:history + groups:history for reading channel history.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN!;

async function slackApi(method: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${SLACK_USER_TOKEN}` },
  });

  if (!res.ok) {
    throw new Error(`Slack API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { ok: boolean; error?: string; [key: string]: unknown };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data;
}

const server = new McpServer({
  name: "slack-search",
  version: "0.1.0",
});

// Tool: Search messages across all accessible channels
server.tool(
  "slack_search_messages",
  "Search across Slack channels for messages matching a query. Supports Slack search modifiers like from:, in:, after:, before:, has:. Returns matching messages with channel, timestamp, and permalink.",
  {
    query: z.string().describe("Slack search query (e.g., 'placements risk', 'in:#admissions after:2026-04-07')"),
    count: z.number().default(20).describe("Number of results to return (default: 20, max: 100)"),
    sort: z.enum(["timestamp", "score"]).default("timestamp").describe("Sort by recency or relevance"),
  },
  async ({ query, count, sort }) => {
    const data = (await slackApi("search.messages", {
      query,
      count: String(Math.min(count, 100)),
      sort,
      sort_dir: "desc",
    })) as {
      messages: {
        total: number;
        matches: Array<{
          text: string;
          username: string;
          ts: string;
          channel: { name: string; id: string };
          permalink: string;
        }>;
      };
    };

    const results = data.messages.matches.map((m) => ({
      channel: m.channel.name,
      channelId: m.channel.id,
      user: m.username,
      text: m.text.slice(0, 500),
      timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
      permalink: m.permalink,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { total: data.messages.total, results },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Read recent messages from a specific channel
server.tool(
  "slack_read_channel_history",
  "Read recent messages from a specific Slack channel. Use this to get context from a known channel.",
  {
    channel_id: z.string().describe("The Slack channel ID (e.g., C01ABCDEF)"),
    limit: z.number().default(30).describe("Number of messages to fetch (default: 30, max: 100)"),
    oldest: z.string().optional().describe("Only messages after this Unix timestamp (e.g., '1712448000' for 2024-04-07)"),
  },
  async ({ channel_id, limit, oldest }) => {
    const params: Record<string, string> = {
      channel: channel_id,
      limit: String(Math.min(limit, 100)),
    };
    if (oldest) params.oldest = oldest;

    const data = (await slackApi("conversations.history", params)) as {
      messages: Array<{
        user?: string;
        text: string;
        ts: string;
        thread_ts?: string;
        reply_count?: number;
      }>;
    };

    const messages = data.messages.map((m) => ({
      user: m.user ?? "bot",
      text: m.text.slice(0, 500),
      timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
      ts: m.ts,
      hasThread: !!m.thread_ts && m.reply_count !== undefined && m.reply_count > 0,
      replyCount: m.reply_count ?? 0,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ channelId: channel_id, messages }, null, 2),
        },
      ],
    };
  }
);

// Tool: Read a specific thread
server.tool(
  "slack_read_thread",
  "Read all replies in a specific Slack thread. Use this to get full context of a discussion.",
  {
    channel_id: z.string().describe("The Slack channel ID"),
    thread_ts: z.string().describe("The thread's parent message timestamp"),
    limit: z.number().default(50).describe("Number of replies to fetch (default: 50, max: 200)"),
  },
  async ({ channel_id, thread_ts, limit }) => {
    const data = (await slackApi("conversations.replies", {
      channel: channel_id,
      ts: thread_ts,
      limit: String(Math.min(limit, 200)),
    })) as {
      messages: Array<{
        user?: string;
        text: string;
        ts: string;
      }>;
    };

    const messages = data.messages.map((m) => ({
      user: m.user ?? "bot",
      text: m.text.slice(0, 500),
      timestamp: new Date(parseFloat(m.ts) * 1000).toISOString(),
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ channelId: channel_id, threadTs: thread_ts, messages }, null, 2),
        },
      ],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Slack MCP server fatal error:", err);
  process.exit(1);
});
