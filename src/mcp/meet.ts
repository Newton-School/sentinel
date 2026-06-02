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
import {
  mapConferences,
  mapTranscripts,
  shapeTranscriptEntry,
  type ConferenceRecord,
  type TranscriptRecord,
  type RawTranscriptEntry,
} from "./meetShape.js";
import { redactedHttpError } from "./httpError.js";
import { fetchWithRetry } from "./httpRetry.js";
import { paginate } from "./paginate.js";
import { assertEnv } from "./requireEnv.js";

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of hitting the OAuth token endpoint with undefined creds.
assertEnv(
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
  process.env,
  { serverName: "google-meet MCP server" }
);

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

  const res = await fetchWithRetry("https://oauth2.googleapis.com/token", {
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
    // Redacted: an OAuth token error body can carry secrets — keep status only.
    throw redactedHttpError("Token refresh failed", res);
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
  const res = await fetchWithRetry(`https://meet.googleapis.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    // Redacted: keep status/statusText, never embed the raw response body.
    throw redactedHttpError("Google Meet API error", res);
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
    const maxItems = Math.min(page_size, 50);

    const { items: records, truncated } = await paginate<ConferenceRecord>({
      maxItems,
      fetchPage: async (cursor) => {
        const params = new URLSearchParams();
        // Request a full page (up to maxItems) on each call; the helper slices
        // the accumulated result back to maxItems.
        params.set("pageSize", String(maxItems));
        if (filter) params.set("filter", filter);
        if (cursor) params.set("pageToken", cursor);

        const data = (await meetFetch(`/conferenceRecords?${params.toString()}`)) as {
          conferenceRecords?: ConferenceRecord[];
          nextPageToken?: string;
        };
        return { items: data.conferenceRecords ?? [], next: data.nextPageToken };
      },
    });

    if (truncated) {
      console.error(
        `meet_list_conferences: truncated at max_results=${maxItems}; more conferences were available.`
      );
    }

    const conferences = mapConferences(records);

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
    // A meeting rarely has more than a handful of transcripts, but follow the
    // page token to be safe, bounded by a sane cap.
    const MAX_TRANSCRIPTS = 50;

    const { items: records, truncated } = await paginate<TranscriptRecord>({
      maxItems: MAX_TRANSCRIPTS,
      fetchPage: async (cursor) => {
        const params = new URLSearchParams();
        if (cursor) params.set("pageToken", cursor);
        const qs = params.toString();
        const path = `/conferenceRecords/${conference_id}/transcripts${qs ? `?${qs}` : ""}`;
        const data = (await meetFetch(path)) as {
          transcripts?: TranscriptRecord[];
          nextPageToken?: string;
        };
        return { items: data.transcripts ?? [], next: data.nextPageToken };
      },
    });

    if (truncated) {
      console.error(
        `meet_list_transcripts: truncated at ${MAX_TRANSCRIPTS} transcripts for conference ${conference_id}; more were available.`
      );
    }

    const transcripts = mapTranscripts(records);

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
    const maxItems = Math.min(page_size, 500);

    const { items: rawEntries, truncated } = await paginate<RawTranscriptEntry>({
      maxItems,
      fetchPage: async (cursor) => {
        const params = new URLSearchParams();
        params.set("pageSize", String(maxItems));
        if (cursor) params.set("pageToken", cursor);

        const data = (await meetFetch(
          `/conferenceRecords/${conference_id}/transcripts/${transcript_id}/entries?${params.toString()}`
        )) as {
          transcriptEntries?: RawTranscriptEntry[];
          nextPageToken?: string;
        };
        return { items: data.transcriptEntries ?? [], next: data.nextPageToken };
      },
    });

    if (truncated) {
      console.error(
        `meet_get_transcript_entries: truncated at page_size=${maxItems} entries for transcript ${transcript_id}; more entries were available.`
      );
    }

    const entries = await Promise.all(
      rawEntries.map(async (e) => {
        // Human-readable display name, resolved from the participant resource
        // (cached). Falls back to the raw resource name if it can't be resolved.
        const speaker = e.participant
          ? await resolveParticipantName(e.participant)
          : undefined;
        return shapeTranscriptEntry(e, speaker);
      })
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
