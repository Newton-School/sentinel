import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock pino (joinStore.test.ts pattern) — meetClient → logger → config, so we
// mock config too and import the module dynamically.
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Response-like fake for the injected fetch (extractor.test.ts pattern). */
function jsonResponse(body: unknown, status = 200, statusText = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

type FetchHandler = (url: string, init?: RequestInit) => Response;

/** Injected fetch that records every call and dispatches via `handler`. */
function makeFetch(handler: FetchHandler) {
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init)
  );
  return {
    impl: fn as unknown as typeof fetch,
    fn,
    callsTo(prefix: string) {
      return fn.mock.calls.filter((c) => String(c[0]).startsWith(prefix));
    },
  };
}

const TOKEN_OK = { access_token: "tok-1", expires_in: 3600 };

async function importMeetClient() {
  vi.doMock("../src/config.js", () => ({
    config: { LOG_LEVEL: "silent" },
  }));
  return import("../src/google/meetClient.js");
}

function clientOpts(fetchImpl: typeof fetch) {
  return {
    clientId: "gid",
    clientSecret: "gsecret",
    refreshToken: "grefresh",
    fetchImpl,
  };
}

describe("createMeetClient", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fetches an OAuth token with the refresh_token grant and form encoding", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({ conferenceRecords: [] });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    await client.listConferenceRecords('end_time>"2026-06-10T00:00:00Z"');

    const tokenCalls = fetch.callsTo(TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
    const init = tokenCalls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = String(init.body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("client_id=gid");
    expect(body).toContain("client_secret=gsecret");
    expect(body).toContain("refresh_token=grefresh");
  });

  it("caches the token — a second API call does not refetch it", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({ conferenceRecords: [] });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    await client.listConferenceRecords("f1");
    await client.listConferenceRecords("f2");

    expect(fetch.callsTo(TOKEN_URL)).toHaveLength(1);
    // Both API calls carry the bearer token.
    const apiCalls = fetch.callsTo("https://meet.googleapis.com/v2");
    expect(apiCalls).toHaveLength(2);
    for (const call of apiCalls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer tok-1");
    }
  });

  it("passes the filter through to conferenceRecords and follows pagination", async () => {
    const { createMeetClient } = await importMeetClient();
    const pageUrls: string[] = [];
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      pageUrls.push(url);
      const u = new URL(url);
      if (!u.searchParams.get("pageToken")) {
        return jsonResponse({
          conferenceRecords: [{ name: "conferenceRecords/a" }],
          nextPageToken: "NEXT",
        });
      }
      return jsonResponse({ conferenceRecords: [{ name: "conferenceRecords/b" }] });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    const filter = 'end_time>"2026-06-10T12:00:00.000Z"';
    const records = await client.listConferenceRecords(filter);

    expect(records.map((r) => r.name)).toEqual([
      "conferenceRecords/a",
      "conferenceRecords/b",
    ]);
    expect(pageUrls).toHaveLength(2);
    const first = new URL(pageUrls[0]);
    expect(first.pathname).toBe("/v2/conferenceRecords");
    expect(first.searchParams.get("filter")).toBe(filter);
    expect(first.searchParams.get("pageToken")).toBeNull();
    const second = new URL(pageUrls[1]);
    expect(second.searchParams.get("pageToken")).toBe("NEXT");
    expect(second.searchParams.get("filter")).toBe(filter);
  });

  it("lists transcripts under the conference record resource name", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({
        transcripts: [{ name: "conferenceRecords/r1/transcripts/t1" }],
      });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    const transcripts = await client.listTranscripts("conferenceRecords/r1");

    expect(transcripts).toHaveLength(1);
    expect(transcripts[0].name).toBe("conferenceRecords/r1/transcripts/t1");
    const apiCall = fetch.callsTo("https://meet.googleapis.com/v2")[0];
    expect(String(apiCall[0])).toContain("/v2/conferenceRecords/r1/transcripts");
  });

  it("paginates transcript entries", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      const u = new URL(url);
      expect(u.pathname).toBe(
        "/v2/conferenceRecords/r1/transcripts/t1/entries"
      );
      if (!u.searchParams.get("pageToken")) {
        return jsonResponse({
          transcriptEntries: [{ text: "one" }],
          nextPageToken: "P2",
        });
      }
      return jsonResponse({ transcriptEntries: [{ text: "two" }] });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    const entries = await client.listTranscriptEntries(
      "conferenceRecords/r1/transcripts/t1"
    );
    expect(entries.map((e) => e.text)).toEqual(["one", "two"]);
  });

  it("resolves a participant display name and caches it", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({ signedinUser: { displayName: "Alice" } });
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    const resource = "conferenceRecords/r1/participants/p1";
    expect(await client.resolveParticipantName(resource)).toBe("Alice");
    expect(await client.resolveParticipantName(resource)).toBe("Alice");

    // One participant fetch total — the second resolve was a cache hit.
    expect(fetch.callsTo("https://meet.googleapis.com/v2")).toHaveLength(1);
  });

  it("falls back to the raw resource name when resolution fails (and caches it)", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({ error: "nope" }, 403, "Forbidden");
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    const resource = "conferenceRecords/r1/participants/p404";
    expect(await client.resolveParticipantName(resource)).toBe(resource);
    expect(await client.resolveParticipantName(resource)).toBe(resource);
    // Failure result cached: only one fetch was attempted.
    expect(fetch.callsTo("https://meet.googleapis.com/v2")).toHaveLength(1);
  });

  it("throws a REDACTED error on a non-ok API response (status only, no body)", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch((url) => {
      if (url.startsWith(TOKEN_URL)) return jsonResponse(TOKEN_OK);
      return jsonResponse({ secret: "super-secret-body" }, 403, "Forbidden");
    });

    const client = createMeetClient(clientOpts(fetch.impl));
    await expect(client.listConferenceRecords("f")).rejects.toThrow(
      /Google Meet API error: 403/
    );
    await expect(client.listConferenceRecords("f")).rejects.not.toThrow(
      /super-secret-body/
    );
  });

  it("throws a REDACTED error when the token refresh fails", async () => {
    const { createMeetClient } = await importMeetClient();
    const fetch = makeFetch(() =>
      jsonResponse({ error: "invalid_grant", secret: "leaky" }, 400, "Bad Request")
    );

    const client = createMeetClient(clientOpts(fetch.impl));
    await expect(client.listConferenceRecords("f")).rejects.toThrow(
      /Token refresh failed: 400/
    );
  });
});
