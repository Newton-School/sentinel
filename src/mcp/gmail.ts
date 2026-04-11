#!/usr/bin/env node

/**
 * Gmail MCP Server — exposes Gmail search and reading as MCP tools.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Uses OAuth2 with a refresh token for the Sentinel Google service account.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { z } from "zod";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const gmail = google.gmail({ version: "v1", auth });

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
    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(max_results, 50),
    });

    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total: 0, results: [] }) }],
      };
    }

    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date", "Cc"],
        });

        const headers = detail.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

        return {
          id: msg.id,
          threadId: detail.data.threadId,
          snippet: detail.data.snippet ?? "",
          from: getHeader("From"),
          to: getHeader("To"),
          cc: getHeader("Cc"),
          subject: getHeader("Subject"),
          date: getHeader("Date"),
          labelIds: detail.data.labelIds,
        };
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: listRes.data.resultSizeEstimate, results }, null, 2),
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
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: thread_id,
      format: "full",
    });

    const messages = (thread.data.messages ?? []).map((msg) => {
      const headers = msg.payload?.headers ?? [];
      const getHeader = (name: string) =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      // Extract plain text body
      let body = "";
      const parts = msg.payload?.parts ?? [];
      if (parts.length > 0) {
        const textPart = parts.find((p) => p.mimeType === "text/plain");
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, "base64").toString("utf-8");
        }
      } else if (msg.payload?.body?.data) {
        body = Buffer.from(msg.payload.body.data, "base64").toString("utf-8");
      }

      return {
        from: getHeader("From"),
        to: getHeader("To"),
        subject: getHeader("Subject"),
        date: getHeader("Date"),
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
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - days);
    const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, "0")}/${String(afterDate.getDate()).padStart(2, "0")}`;

    let query = `after:${afterStr}`;
    if (label) query += ` label:${label}`;

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(max_results, 50),
    });

    const messages = listRes.data.messages ?? [];
    if (messages.length === 0) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ total: 0, results: [] }) }],
      };
    }

    const results = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });

        const headers = detail.data.payload?.headers ?? [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

        return {
          id: msg.id,
          threadId: detail.data.threadId,
          snippet: detail.data.snippet ?? "",
          from: getHeader("From"),
          subject: getHeader("Subject"),
          date: getHeader("Date"),
        };
      })
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ total: listRes.data.resultSizeEstimate, results }, null, 2),
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
