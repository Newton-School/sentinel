#!/usr/bin/env node

/**
 * Gmail MCP Server — exposes Gmail search and reading as MCP tools.
 * Runs as a stdio-based MCP server, spawned by the agent harness over stdio MCP.
 *
 * Uses OAuth2 with a refresh token for the Sentinel Google service account.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { z } from "zod";
import { extractPlainTextBody } from "./gmailBody.js";
import {
  getHeader,
  buildRecentQuery,
  shapeSearchResult,
  shapeListResult,
} from "./gmailList.js";
import { paginate } from "./paginate.js";
import { assertEnv } from "./requireEnv.js";

/** Minimal shape of a Gmail message-list stub (id + threadId). */
interface GmailMessageStub {
  id?: string | null;
}

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of constructing an OAuth client with undefined creds.
assertEnv(
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  process.env,
  { serverName: "gmail MCP server" }
);

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth });

// Per-request timeout (ms) so a hung Google API call can't block a tool call
// indefinitely. googleapis/gaxios provides its own transient-error retry.
const REQUEST_TIMEOUT_MS = 15_000;

const server = new McpServer({
  name: "gmail",
  version: "0.1.0",
});

// Tool: Search emails using Gmail query syntax
server.tool(
  "gmail_search",
  "Search emails using Gmail query syntax. Supports operators like from:, to:, subject:, after:, before:, has:attachment, label:, is:. Returns message snippets and metadata.",
  {
    query: z.string().describe("Gmail search query (e.g., 'subject:admissions after:2026/04/07', 'from:ceo@newtonschool.co')"),
    max_results: z.number().default(15).describe("Maximum number of results (default: 15, max: 50)"),
  },
  async ({ query, max_results }) => {
    const maxItems = Math.min(max_results, 50);
    let resultSizeEstimate: number | null | undefined;

    const { items: messages, truncated } = await paginate<GmailMessageStub>({
      maxItems,
      fetchPage: async (cursor) => {
        const listRes = await gmail.users.messages.list(
          {
            userId: "me",
            q: query,
            maxResults: maxItems,
            pageToken: cursor,
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        // Preserve the first page's estimate for the output's `total` field.
        if (resultSizeEstimate === undefined) {
          resultSizeEstimate = listRes.data.resultSizeEstimate;
        }
        return {
          items: listRes.data.messages ?? [],
          next: listRes.data.nextPageToken ?? undefined,
        };
      },
    });

    if (truncated) {
      console.error(
        `gmail_search: truncated at max_results=${maxItems}; more messages matched.`
      );
    }

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total: 0, results: [] }) }],
      };
    }

    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get(
          {
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date", "Cc"],
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );

        return shapeSearchResult(msg.id, detail.data);
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: resultSizeEstimate, results }, null, 2),
        },
      ],
    };
  }
);

// Tool: Read a full email thread
server.tool(
  "gmail_read_thread",
  "Read all messages in an email thread by thread ID. Returns the full conversation with sender, subject, date, and body text.",
  {
    thread_id: z.string().describe("The Gmail thread ID (from gmail_search results)"),
  },
  async ({ thread_id }) => {
    const thread = await gmail.users.threads.get(
      {
        userId: "me",
        id: thread_id,
        format: "full",
      },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    const messages = (thread.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];

      // Extract plain text body, recursing the full MIME part tree.
      let body = extractPlainTextBody(msg.payload);

      return {
        from: getHeader(headers, "From"),
        to: getHeader(headers, "To"),
        subject: getHeader(headers, "Subject"),
        date: getHeader(headers, "Date"),
        body: body.slice(0, 2000),
      };
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ threadId: thread_id, messageCount: messages.length, messages }, null, 2),
        },
      ],
    };
  }
);

// Tool: List recent emails
server.tool(
  "gmail_list_recent",
  "List recent emails from the last N days. Optionally filter by label or sender.",
  {
    days: z.number().default(7).describe("Number of days to look back (default: 7)"),
    label: z.string().optional().describe("Gmail label to filter by (e.g., 'INBOX', 'IMPORTANT')"),
    max_results: z.number().default(20).describe("Maximum results (default: 20, max: 50)"),
  },
  async ({ days, label, max_results }) => {
    const query = buildRecentQuery(days, new Date(), label);
    const maxItems = Math.min(max_results, 50);
    let resultSizeEstimate: number | null | undefined;

    const { items: messages, truncated } = await paginate<GmailMessageStub>({
      maxItems,
      fetchPage: async (cursor) => {
        const listRes = await gmail.users.messages.list(
          {
            userId: "me",
            q: query,
            maxResults: maxItems,
            pageToken: cursor,
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        if (resultSizeEstimate === undefined) {
          resultSizeEstimate = listRes.data.resultSizeEstimate;
        }
        return {
          items: listRes.data.messages ?? [],
          next: listRes.data.nextPageToken ?? undefined,
        };
      },
    });

    if (truncated) {
      console.error(
        `gmail_list_recent: truncated at max_results=${maxItems}; more messages were available.`
      );
    }

    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total: 0, results: [] }) }],
      };
    }

    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get(
          {
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );

        return shapeListResult(msg.id, detail.data);
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: resultSizeEstimate, results }, null, 2),
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
  console.error("Gmail MCP server fatal error:", err);
  process.exit(1);
});
