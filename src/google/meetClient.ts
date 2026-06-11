/**
 * In-process Google Meet REST API v2 client for the memory ingestion pipeline.
 *
 * The Meet MCP server (src/mcp/meet.ts) is a separate-process stdio entrypoint
 * and cannot be imported, so this module ports its plumbing — OAuth
 * refresh-token grant with in-process expiry caching, paginated
 * conferenceRecords/transcripts/entries reads, and cached participant-name
 * resolution — behind an injectable-fetch factory the ingest watcher (and
 * tests) can construct directly.
 *
 * Reuses the shared MCP helpers: `fetchWithRetry` (timeout + bounded retry),
 * `redactedHttpError` (never leaks upstream bodies), `paginate` (bounded
 * cursor walking), and `participantDisplayName` (pure name precedence).
 */

import { createLogger } from "../logging/logger.js";
import { fetchWithRetry } from "../mcp/httpRetry.js";
import { redactedHttpError } from "../mcp/httpError.js";
import { paginate } from "../mcp/paginate.js";
import {
  participantDisplayName,
  type MeetParticipant,
} from "../mcp/participantName.js";
import type {
  ConferenceRecord,
  RawTranscriptEntry,
  TranscriptRecord,
} from "../mcp/meetShape.js";

const log = createLogger("meet-client");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MEET_API_BASE = "https://meet.googleapis.com/v2";

/** Max conference records fetched per listConferenceRecords call. */
const MAX_CONFERENCE_RECORDS = 50;
/** Max transcripts fetched per conference (rarely more than a handful exist). */
const MAX_TRANSCRIPTS = 50;
/** Default max transcript entries fetched per transcript. */
export const DEFAULT_MAX_TRANSCRIPT_ENTRIES = 2000;
/** Per-request page size for transcript entries. */
const ENTRIES_PAGE_SIZE = 100;

export interface MeetClientOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Injectable fetch for tests (threaded into fetchWithRetry). */
  fetchImpl?: typeof fetch;
}

export interface MeetClient {
  listConferenceRecords(filter: string): Promise<ConferenceRecord[]>;
  listTranscripts(conferenceRecordName: string): Promise<TranscriptRecord[]>;
  listTranscriptEntries(
    transcriptName: string,
    maxItems?: number
  ): Promise<RawTranscriptEntry[]>;
  resolveParticipantName(participantResourceName: string): Promise<string>;
}

export function createMeetClient(opts: MeetClientOptions): MeetClient {
  let cachedToken: { token: string; expiresAt: number } | null = null;

  // OAuth refresh-token grant with a 30s-early expiry cache (meet.ts port).
  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
      return cachedToken.token;
    }

    const res = await fetchWithRetry(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: opts.clientId,
          client_secret: opts.clientSecret,
          refresh_token: opts.refreshToken,
          grant_type: "refresh_token",
        }),
      },
      { fetchImpl: opts.fetchImpl }
    );

    if (!res.ok) {
      // Redacted: an OAuth token error body can carry secrets — status only.
      throw redactedHttpError("Token refresh failed", res);
    }

    const data = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }

  async function meetFetch(path: string): Promise<unknown> {
    const token = await getAccessToken();
    const res = await fetchWithRetry(
      `${MEET_API_BASE}${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      },
      { fetchImpl: opts.fetchImpl }
    );
    if (!res.ok) {
      // Redacted: keep status/statusText, never embed the raw response body.
      throw redactedHttpError("Google Meet API error", res);
    }
    return res.json();
  }

  // Participant resource name → resolved display name, cached for the client's
  // lifetime. A failure-fallback (the raw resource name) is cached too, to
  // avoid refetch storms when one participant repeatedly can't be resolved.
  const participantNameCache = new Map<string, string>();

  return {
    async listConferenceRecords(filter: string): Promise<ConferenceRecord[]> {
      const { items, truncated } = await paginate<ConferenceRecord>({
        maxItems: MAX_CONFERENCE_RECORDS,
        fetchPage: async (cursor) => {
          const params = new URLSearchParams();
          params.set("pageSize", String(MAX_CONFERENCE_RECORDS));
          params.set("filter", filter);
          if (cursor) params.set("pageToken", cursor);

          const data = (await meetFetch(
            `/conferenceRecords?${params.toString()}`
          )) as { conferenceRecords?: ConferenceRecord[]; nextPageToken?: string };
          return { items: data.conferenceRecords ?? [], next: data.nextPageToken };
        },
      });

      if (truncated) {
        log.warn(
          { filter, maxItems: MAX_CONFERENCE_RECORDS },
          "listConferenceRecords truncated — more conferences were available"
        );
      }
      return items;
    },

    async listTranscripts(
      conferenceRecordName: string
    ): Promise<TranscriptRecord[]> {
      const { items, truncated } = await paginate<TranscriptRecord>({
        maxItems: MAX_TRANSCRIPTS,
        fetchPage: async (cursor) => {
          const params = new URLSearchParams();
          if (cursor) params.set("pageToken", cursor);
          const qs = params.toString();
          const data = (await meetFetch(
            `/${conferenceRecordName}/transcripts${qs ? `?${qs}` : ""}`
          )) as { transcripts?: TranscriptRecord[]; nextPageToken?: string };
          return { items: data.transcripts ?? [], next: data.nextPageToken };
        },
      });

      if (truncated) {
        log.warn(
          { conferenceRecordName, maxItems: MAX_TRANSCRIPTS },
          "listTranscripts truncated — more transcripts were available"
        );
      }
      return items;
    },

    async listTranscriptEntries(
      transcriptName: string,
      maxItems = DEFAULT_MAX_TRANSCRIPT_ENTRIES
    ): Promise<RawTranscriptEntry[]> {
      const { items, truncated } = await paginate<RawTranscriptEntry>({
        maxItems,
        maxPages: Math.max(1, Math.ceil(maxItems / ENTRIES_PAGE_SIZE)),
        fetchPage: async (cursor) => {
          const params = new URLSearchParams();
          params.set("pageSize", String(Math.min(maxItems, ENTRIES_PAGE_SIZE)));
          if (cursor) params.set("pageToken", cursor);

          const data = (await meetFetch(
            `/${transcriptName}/entries?${params.toString()}`
          )) as {
            transcriptEntries?: RawTranscriptEntry[];
            nextPageToken?: string;
          };
          return { items: data.transcriptEntries ?? [], next: data.nextPageToken };
        },
      });

      if (truncated) {
        log.warn(
          { transcriptName, maxItems },
          "listTranscriptEntries truncated — more entries were available"
        );
      }
      return items;
    },

    /**
     * Resolve a participant RESOURCE NAME to a human display name. On any
     * error (or empty name) it falls back to the raw resource name so a
     * single unresolvable speaker never fails a whole ingestion run.
     */
    async resolveParticipantName(
      participantResourceName: string
    ): Promise<string> {
      const cached = participantNameCache.get(participantResourceName);
      if (cached !== undefined) return cached;

      let resolved = participantResourceName;
      try {
        const participant = (await meetFetch(
          `/${participantResourceName}`
        )) as MeetParticipant;
        const name = participantDisplayName(participant);
        if (name) resolved = name;
      } catch (err) {
        // Swallow: keep the raw resource name as the fallback speaker.
        log.warn(
          { err, participantResourceName },
          "Failed to resolve participant name — using resource name"
        );
      }

      participantNameCache.set(participantResourceName, resolved);
      return resolved;
    },
  };
}
