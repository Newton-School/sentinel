#!/usr/bin/env node

/**
 * Google Meet Transcripts MCP Server — finds and reads meeting transcripts from Google Drive.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Google Meet auto-saves transcripts to Google Drive as Google Docs.
 * This server searches for and reads those transcript documents.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { z } from "zod";
import {
  buildSearchQuery,
  buildRecentQuery,
  extractDocText,
  truncateDocText,
  mapSearchFiles,
  mapRecentFiles,
  type DriveFile,
} from "./transcriptsQuery.js";
import { paginate } from "./paginate.js";
import { assertEnv } from "./requireEnv.js";

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of constructing an OAuth client with undefined creds.
assertEnv(
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  process.env,
  { serverName: "meeting-transcripts MCP server" }
);

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: "v3", auth });
const docs = google.docs({ version: "v1", auth });

// Per-request timeout (ms) so a hung Google API call can't block a tool call
// indefinitely. googleapis/gaxios provides its own transient-error retry.
const REQUEST_TIMEOUT_MS = 15_000;

const server = new McpServer({
  name: "meeting-transcripts",
  version: "0.1.0",
});

// Tool: Search for meeting transcripts
server.tool(
  "transcript_search",
  "Search Google Drive for meeting transcripts. Google Meet saves transcripts as Google Docs. Search by meeting name, keyword, or date range.",
  {
    query: z.string().optional().describe("Keyword to search for in transcript titles/content (e.g., 'leadership standup', 'admissions review')"),
    days_back: z.number().default(14).describe("Number of days to look back (default: 14)"),
    max_results: z.number().default(15).describe("Maximum results (default: 15, max: 30)"),
  },
  async ({ query, days_back, max_results }) => {
    // Google Meet transcripts are Google Docs with specific naming patterns;
    // when a query is given we match it on name/fullText, otherwise we fall back
    // to titles containing "transcript".
    const driveQuery = buildSearchQuery(days_back, new Date(), query);
    const maxItems = Math.min(max_results, 30);

    const { items: rawFiles, truncated } = await paginate<DriveFile>({
      maxItems,
      fetchPage: async (cursor) => {
        const res = await drive.files.list(
          {
            q: driveQuery,
            fields:
              "nextPageToken, files(id, name, createdTime, modifiedTime, webViewLink, owners)",
            orderBy: "modifiedTime desc",
            pageSize: maxItems,
            pageToken: cursor,
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        return {
          items: res.data.files ?? [],
          next: res.data.nextPageToken ?? undefined,
        };
      },
    });

    if (truncated) {
      console.error(
        `transcript_search: truncated at max_results=${maxItems}; more transcripts matched.`
      );
    }

    const files = mapSearchFiles(rawFiles);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ resultCount: files.length, files }, null, 2),
        },
      ],
    };
  }
);

// Tool: Read the full text of a transcript
server.tool(
  "transcript_read",
  "Read the full text content of a meeting transcript from Google Drive. Returns the extracted text from the Google Doc.",
  {
    document_id: z.string().describe("The Google Drive document ID (from transcript_search results)"),
    max_length: z.number().default(5000).describe("Maximum characters to return (default: 5000). Transcripts can be long."),
  },
  async ({ document_id, max_length }) => {
    const doc = await docs.documents.get(
      { documentId: document_id },
      { timeout: REQUEST_TIMEOUT_MS }
    );

    // Extract text from the Google Doc structure, then apply the length cap.
    const fullText = extractDocText(doc.data);
    const { characterCount, truncated, content } = truncateDocText(
      fullText,
      max_length
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              documentId: document_id,
              title: doc.data.title,
              characterCount,
              truncated,
              content,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: List recent meeting transcripts
server.tool(
  "transcript_list_recent",
  "List recent meeting transcripts from Google Drive. Returns transcripts sorted by most recent first.",
  {
    days: z.number().default(7).describe("Number of days to look back (default: 7)"),
    max_results: z.number().default(10).describe("Maximum results (default: 10, max: 30)"),
  },
  async ({ days, max_results }) => {
    const driveQuery = buildRecentQuery(days, new Date());
    const maxItems = Math.min(max_results, 30);

    const { items: rawFiles, truncated } = await paginate<DriveFile>({
      maxItems,
      fetchPage: async (cursor) => {
        const res = await drive.files.list(
          {
            q: driveQuery,
            fields:
              "nextPageToken, files(id, name, createdTime, modifiedTime, webViewLink)",
            orderBy: "modifiedTime desc",
            pageSize: maxItems,
            pageToken: cursor,
          },
          { timeout: REQUEST_TIMEOUT_MS }
        );
        return {
          items: res.data.files ?? [],
          next: res.data.nextPageToken ?? undefined,
        };
      },
    });

    if (truncated) {
      console.error(
        `transcript_list_recent: truncated at max_results=${maxItems}; more transcripts were available.`
      );
    }

    const files = mapRecentFiles(rawFiles);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ resultCount: files.length, files }, null, 2),
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
  console.error("Meeting Transcripts MCP server fatal error:", err);
  process.exit(1);
});
