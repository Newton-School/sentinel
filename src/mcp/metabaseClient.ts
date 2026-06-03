/**
 * Side-effect-free Metabase API client.
 *
 * This module contains NO top-level `process.env` reads and NO server bootstrap,
 * so it can be imported directly in unit tests. `metabase.ts` builds a single
 * client from `process.env` and the tool handlers call `client.metabaseFetch`.
 *
 * Two auth modes:
 *  - **API-key mode** (`apiKey` set): every request carries header
 *    `X-API-KEY: <key>`. No `/api/session` round-trip, no session token, and no
 *    401 re-auth loop. This is the headless/EC2 path (also bypasses SSO).
 *  - **Session mode** (`username` + `password`): POST `/api/session` for an
 *    `X-Metabase-Session` token (per-client closure state) and re-authenticate
 *    once on a 401.
 */

import { redactedHttpError } from "./httpError.js";
import { fetchWithRetry } from "./httpRetry.js";

export interface MetabaseClientOptions {
  url: string;
  apiKey?: string;
  username?: string;
  password?: string;
}

export interface MetabaseClient {
  getSession(): Promise<string>;
  metabaseFetch(path: string, options?: RequestInit): Promise<unknown>;
}

// Metabase keeps its own 401 re-auth retry loop below, and its unit suite
// asserts exact upstream call counts per path. We therefore wrap fetch only for
// the per-request TIMEOUT guard (a hung Metabase can't block a tool forever)
// and disable fetchWithRetry's own 429/5xx retry here (retries: 0) to preserve
// that single-attempt-per-path behavior. Slack and Meet use the full default
// retry-with-backoff.
const METABASE_FETCH_OPTS = { retries: 0 } as const;

export function createMetabaseClient(opts: MetabaseClientOptions): MetabaseClient {
  const { url, apiKey, username, password } = opts;

  // API-key mode: stateless. Header `X-API-KEY` on every request, no session,
  // no 401 re-auth loop. `getSession` is unused here but kept on the returned
  // object for interface compatibility.
  if (apiKey) {
    // Capture into a const so the narrowing from `string | undefined` to
    // `string` survives into the closures below.
    const key = apiKey;

    async function getSession(): Promise<string> {
      throw new Error("getSession is not used with API-key auth");
    }

    async function metabaseFetch(
      path: string,
      options: RequestInit = {}
    ): Promise<unknown> {
      const res = await fetchWithRetry(
        `${url}${path}`,
        {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": key,
            ...options.headers,
          },
        },
        METABASE_FETCH_OPTS
      );

      if (!res.ok) {
        // Redacted: keep status/statusText, never embed the raw response body.
        // No 401 re-auth — an API key doesn't expire mid-request.
        throw redactedHttpError("Metabase API error", res);
      }

      return res.json();
    }

    return { getSession, metabaseFetch };
  }

  let sessionToken: string | null = null;

  async function getSession(): Promise<string> {
    if (sessionToken) return sessionToken;

    const res = await fetchWithRetry(
      `${url}/api/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      },
      METABASE_FETCH_OPTS
    );

    if (!res.ok) {
      // Redacted: keep status/statusText, never embed the raw response body
      // (it can carry credentials / identifiers that leak into logs + Slack).
      throw redactedHttpError("Metabase auth failed", res);
    }

    const data = (await res.json()) as { id: string };
    sessionToken = data.id;
    return sessionToken;
  }

  async function metabaseFetch(
    path: string,
    options: RequestInit = {}
  ): Promise<unknown> {
    const token = await getSession();
    const res = await fetchWithRetry(
      `${url}${path}`,
      {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Metabase-Session": token,
          ...options.headers,
        },
      },
      METABASE_FETCH_OPTS
    );

    if (res.status === 401) {
      // Token expired, retry with fresh session
      sessionToken = null;
      const newToken = await getSession();
      const retry = await fetchWithRetry(
        `${url}${path}`,
        {
          ...options,
          headers: {
            "Content-Type": "application/json",
            "X-Metabase-Session": newToken,
            ...options.headers,
          },
        },
        METABASE_FETCH_OPTS
      );

      // Guard: if the re-auth retry still failed, surface the auth failure
      // instead of returning the error body as if it were data — otherwise
      // downstream code crashes opaquely on e.g. `result.data.cols`.
      if (!retry.ok) {
        throw redactedHttpError("Metabase API error after re-auth", retry);
      }

      return retry.json();
    }

    if (!res.ok) {
      throw redactedHttpError("Metabase API error", res);
    }

    return res.json();
  }

  return { getSession, metabaseFetch };
}
