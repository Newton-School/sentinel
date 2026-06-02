#!/usr/bin/env node

/**
 * Google Meet MCP Server — exposes Meet REST API v2 for fetching conference records and transcripts.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Uses OAuth2 with a refresh token for the Sentinel Google service account.
 * Requires the scope: https://www.googleapis.com/auth/meetings.space.readonly
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { participantDisplayName, type MeetParticipant } from "./participantName.js";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!;
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN!;

let cachedToken: { token: string; expiresAt: number } | null = null;

// Google Meet API v2 isn't in the main `googleapis` discovery, so we use
// direct fetch against the token endpoint and REST API.
async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
    return cachedToken.token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${errText}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function meetFetch(path: string): Promise<unknown> {
  const token = await getAccessToken();
  const res = await fetch(`https://meet.googleapis.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Google Meet API error: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// In-memory cache of participant resource name -> resolved human display name.
// Scoped to the lifetime of this MCP server process. We cache even on a
// failure-fallback (the raw resource name) to avoid refetch storms when one
// participant repeatedly can't be resolved.
const participantNameCache = new Map<string, string>();

/**
 * Resolve a Meet participant RESOURCE NAME
 * (`conferenceRecords/{conf}/participants/{p}`) to a human display name.
 *
 * Checks the in-memory cache first; on a miss it fetches the Participant
 * resource via the authenticated meetFetch helper and extracts the best
 * display name. On any error (or empty name) it falls back to the raw resource
 * name so a single unresolvable speaker never fails the whole tool call.
 */
async function resolveParticipantName(resourceName: string): Promise<string> {
  const cached = participantNameCache.get(resourceName);
  if (cached !== undefined) return cached;

  let resolved = resourceName;
  try {
    const participant = (await meetFetch(`/${resourceName}`)) as MeetParticipant;
    const name = participantDisplayName(participant);
    if (name) resolved = name;
  } catch (err) {
    // Swallow: keep the raw resource name as the fallback speaker.
    console.error(`Failed to resolve participant "${resourceName}":`, err);
  }

  participantNameCache.set(resourceName, resolved);
  return resolved;
}

const server = new McpServer({
  name: "google-meet",
  version: "0.1.0",
});

// Tool: List past conference records (meetings that have ended)
server.tool(
  "meet_list_conferences",
  "List past Google Meet conferences (meetings that have ended) accessible to the Sentinel account. Returns conference records with start/end times.",
  {
    page_size: z.number().default(20).describe("Max results (default: 20, max: 50)"),
    filter: z.string().optional().describe("Filter expression, e.g. 'start_time >= \"2026-04-01T00:00:00Z\"'"),
  },
  async ({ page_size, filter }) => {
    const params = new URLSearchParams();
    params.set("pageSize", String(Math.min(page_size, 50)));
    if (filter) params.set("filter", filter);

    const data = (await meetFetch(`/conferenceRecords?${params.toString()}`)) as {
      conferenceRecords?: Array<{
        name: string;
        startTime?: string;
        endTime?: string;
        space?: string;
      }>;
    };

    const conferences = (data.conferenceRecords ?? []).map((c) => ({
      id: c.name?.split("/").pop(),
      resourceName: c.name,
      startTime: c.startTime,
      endTime: c.endTime,
      spaceName: c.space,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: conferences.length, conferences }, null, 2),
        },
      ],
    };
  }
);

// Tool: Get details of a specific conference
server.tool(
  "meet_get_conference",
  "Get details of a specific Google Meet conference record by ID.",
  {
    conference_id: z.string().describe("Conference record ID (from meet_list_conferences)"),
  },
  async ({ conference_id }) => {
    const data = await meetFetch(`/conferenceRecords/${conference_id}`);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    };
  }
);

// Tool: List transcripts for a conference
server.tool(
  "meet_list_transcripts",
  "List all transcripts for a Google Meet conference. A meeting may have multiple transcripts (one per language/format).",
  {
    conference_id: z.string().describe("Conference record ID"),
  },
  async ({ conference_id }) => {
    const data = (await meetFetch(`/conferenceRecords/${conference_id}/transcripts`)) as {
      transcripts?: Array<{
        name: string;
        state?: string;
        startTime?: string;
        endTime?: string;
        docsDestination?: { document?: string; exportUri?: string };
      }>;
    };

    const transcripts = (data.transcripts ?? []).map((t) => ({
      id: t.name?.split("/").pop(),
      resourceName: t.name,
      state: t.state,
      startTime: t.startTime,
      endTime: t.endTime,
      driveDocumentId: t.docsDestination?.document,
      driveDocumentUrl: t.docsDestination?.exportUri,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ count: transcripts.length, transcripts }, null, 2),
        },
      ],
    };
  }
);

// Tool: Get transcript entries (the actual spoken text with speakers and timestamps)
server.tool(
  "meet_get_transcript_entries",
  "Fetch the actual spoken content of a transcript — returns entries with speaker name, start/end times, and text. This is the core tool for reading what was said in a meeting.",
  {
    conference_id: z.string().describe("Conference record ID"),
    transcript_id: z.string().describe("Transcript ID (from meet_list_transcripts)"),
    page_size: z.number().default(100).describe("Max entries per page (default: 100, max: 500)"),
  },
  async ({ conference_id, transcript_id, page_size }) => {
    const params = new URLSearchParams();
    params.set("pageSize", String(Math.min(page_size, 500)));

    const data = (await meetFetch(
      `/conferenceRecords/${conference_id}/transcripts/${transcript_id}/entries?${params.toString()}`
    )) as {
      transcriptEntries?: Array<{
        participant?: string;
        text?: string;
        languageCode?: string;
        startTime?: string;
        endTime?: string;
      }>;
    };

    const entries = await Promise.all(
      (data.transcriptEntries ?? []).map(async (e) => ({
        // Human-readable display name, resolved from the participant resource
        // (cached). Falls back to the raw resource name if it can't be resolved.
        speaker: e.participant ? await resolveParticipantName(e.participant) : undefined,
        // Raw participant resource name retained so nothing is lost.
        participant: e.participant,
        speakerId: e.participant,
        text: e.text,
        startTime: e.startTime,
        endTime: e.endTime,
        language: e.languageCode,
      }))
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { entryCount: entries.length, entries },
            null,
            2
          ),
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
  console.error("Google Meet MCP server fatal error:", err);
  process.exit(1);
});
