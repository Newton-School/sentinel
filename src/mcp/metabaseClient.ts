/**
 * Side-effect-free Metabase API client.
 *
 * This module contains NO top-level `process.env` reads and NO server bootstrap,
 * so it can be imported directly in unit tests. `metabase.ts` builds a single
 * client from `process.env` and the tool handlers call `client.metabaseFetch`.
 *
 * Session token is per-client closure state: each client owns its own Metabase
 * session and re-authenticates on a 401.
 */

export interface MetabaseClientOptions {
  url: string;
  username: string;
  password: string;
}

export interface MetabaseClient {
  getSession(): Promise<string>;
  metabaseFetch(path: string, options?: RequestInit): Promise<unknown>;
}

export function createMetabaseClient(opts: MetabaseClientOptions): MetabaseClient {
  const { url, username, password } = opts;

  let sessionToken: string | null = null;

  async function getSession(): Promise<string> {
    if (sessionToken) return sessionToken;

    const res = await fetch(`${url}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      throw new Error(`Metabase auth failed: ${res.status} ${await res.text()}`);
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
    const res = await fetch(`${url}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Metabase-Session": token,
        ...options.headers,
      },
    });

    if (res.status === 401) {
      // Token expired, retry with fresh session
      sessionToken = null;
      const newToken = await getSession();
      const retry = await fetch(`${url}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Metabase-Session": newToken,
          ...options.headers,
        },
      });

      // Guard: if the re-auth retry still failed, surface the auth failure
      // instead of returning the error body as if it were data — otherwise
      // downstream code crashes opaquely on e.g. `result.data.cols`.
      if (!retry.ok) {
        throw new Error(
          `Metabase API error after re-auth: ${retry.status} ${await retry.text()}`
        );
      }

      return retry.json();
    }

    if (!res.ok) {
      throw new Error(`Metabase API error: ${res.status} ${await res.text()}`);
    }

    return res.json();
  }

  return { getSession, metabaseFetch };
}
