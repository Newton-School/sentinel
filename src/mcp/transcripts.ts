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

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

const auth = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
auth.setCredentials({ refresh_token: REFRESH_TOKEN });

const drive = google.drive({ version: "v3", auth });
const docs = google.docs({ version: "v1", auth });

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
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - days_back);
    const afterStr = afterDate.toISOString();

    // Google Meet transcripts are Google Docs with specific naming patterns
    let driveQuery = `mimeType='application/vnd.google-apps.document' and modifiedTime > '${afterStr}' and trashed = false`;

    // Meet transcripts typically have names like "Meeting transcript - [Meeting Name]"
    if (query) {
      driveQuery += ` and (name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}')`;
    } else {
      driveQuery += ` and name contains 'transcript'`;
    }

    const res = await drive.files.list({
      q: driveQuery,
      fields: "files(id, name, createdTime, modifiedTime, webViewLink, owners)",
      orderBy: "modifiedTime desc",
      pageSize: Math.min(max_results, 30),
    });

    const files = (res.data.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      webViewLink: file.webViewLink,
      owner: file.owners?.[0]?.emailAddress,
    }));

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
    const doc = await docs.documents.get({ documentId: document_id });

    // Extract text from the Google Doc structure
    let fullText = "";
    for (const element of doc.data.body?.content ?? []) {
      if (element.paragraph) {
        for (const elem of element.paragraph.elements ?? []) {
          if (elem.textRun?.content) {
            fullText += elem.textRun.content;
          }
        }
      }
    }

    const truncated = fullText.length > max_length;
    const text = truncated ? fullText.slice(0, max_length) : fullText;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              documentId: document_id,
              title: doc.data.title,
              characterCount: fullText.length,
              truncated,
              content: text,
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
    const afterDate = new Date();
    afterDate.setDate(afterDate.getDate() - days);
    const afterStr = afterDate.toISOString();

    const driveQuery = `mimeType='application/vnd.google-apps.document' and modifiedTime > '${afterStr}' and trashed = false and name contains 'transcript'`;

    const res = await drive.files.list({
      q: driveQuery,
      fields: "files(id, name, createdTime, modifiedTime, webViewLink)",
      orderBy: "modifiedTime desc",
      pageSize: Math.min(max_results, 30),
    });

    const files = (res.data.files ?? []).map((file) => ({
      id: file.id,
      name: file.name,
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      webViewLink: file.webViewLink,
    }));

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
