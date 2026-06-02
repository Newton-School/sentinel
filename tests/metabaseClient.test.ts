import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMetabaseClient } from "../src/mcp/metabaseClient.js";

/**
 * Build a Response-like fake for the global fetch mock.
 */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  json?: unknown;
  text?: string;
}): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    statusText: opts.statusText ?? "",
    json: async () => opts.json,
    text: async () => opts.text ?? "",
  } as unknown as Response;
}

const CLIENT_OPTS = {
  url: "http://mb.test",
  username: "u",
  password: "p",
};

describe("createMetabaseClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("happy path: authenticates then returns parsed data", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      // session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok" } }))
      // data fetch
      .mockResolvedValueOnce(
        fakeResponse({ ok: true, status: 200, json: { data: { rows: [], cols: [] } } })
      );

    const client = createMetabaseClient(CLIENT_OPTS);
    const result = await client.metabaseFetch("/api/dataset", { method: "POST" });

    expect(result).toEqual({ data: { rows: [], cols: [] } });

    // First call is the session POST, second is the data fetch with the token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [sessionUrl, sessionInit] = fetchMock.mock.calls[0];
    expect(sessionUrl).toBe("http://mb.test/api/session");
    expect(sessionInit.method).toBe("POST");

    const [dataUrl, dataInit] = fetchMock.mock.calls[1];
    expect(dataUrl).toBe("http://mb.test/api/dataset");
    expect(dataInit.headers["X-Metabase-Session"]).toBe("tok");
  });

  it("401 then retry OK: re-authenticates and returns the retried data", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      // initial session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok1" } }))
      // first data fetch -> 401
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 401 }))
      // re-auth session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok2" } }))
      // retry data fetch -> ok
      .mockResolvedValueOnce(
        fakeResponse({ ok: true, status: 200, json: { data: { rows: [[1]], cols: [{ name: "x" }] } } })
      );

    const client = createMetabaseClient(CLIENT_OPTS);
    const result = await client.metabaseFetch("/api/dataset");

    expect(result).toEqual({ data: { rows: [[1]], cols: [{ name: "x" }] } });

    // 2 session POSTs + 2 data fetches = 4 calls, re-auth happened.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe("http://mb.test/api/session");
    expect(fetchMock.mock.calls[2][0]).toBe("http://mb.test/api/session");

    // The retried data fetch uses the fresh token.
    const [, retryInit] = fetchMock.mock.calls[3];
    expect(retryInit.headers["X-Metabase-Session"]).toBe("tok2");
  });

  it("401 then retry NOT ok: throws surfacing the auth failure (the guard)", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      // initial session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok1" } }))
      // first data fetch -> 401
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 401 }))
      // re-auth session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok2" } }))
      // retry data fetch -> still failing (500). The raw body must be redacted:
      // it must NOT appear in the thrown error message.
      .mockResolvedValueOnce(
        fakeResponse({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: "still broken: secret-row-data",
        })
      );

    const client = createMetabaseClient(CLIENT_OPTS);

    const err = await client.metabaseFetch("/api/dataset").catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // Redacted: status + statusText kept for debuggability.
    expect(err.message).toBe(
      "Metabase API error after re-auth: 500 Internal Server Error"
    );
    // The raw upstream body must never leak into the thrown error.
    expect(err.message).not.toContain("still broken");
    expect(err.message).not.toContain("secret-row-data");

    // Re-auth was attempted before the failure surfaced.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("non-401 error: throws", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      // session POST
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200, json: { id: "tok" } }))
      // data fetch -> 500. Body must be redacted out of the thrown message.
      .mockResolvedValueOnce(
        fakeResponse({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: "boom: leaked-pii",
        })
      );

    const client = createMetabaseClient(CLIENT_OPTS);

    const err = await client.metabaseFetch("/api/dataset").catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Metabase API error: 500 Internal Server Error");
    // The raw upstream body must never leak into the thrown error.
    expect(err.message).not.toContain("boom");
    expect(err.message).not.toContain("leaked-pii");

    // No re-auth on a non-401 error.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("auth failure: throws a redacted message without the response body", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      // session POST -> 401 with a sensitive body
      .mockResolvedValueOnce(
        fakeResponse({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: "bad password: hunter2",
        })
      );

    const client = createMetabaseClient(CLIENT_OPTS);

    const err = await client.getSession().catch((e) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("Metabase auth failed: 401 Unauthorized");
    // Credentials / body must never leak into the thrown error.
    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("bad password");
  });
});
