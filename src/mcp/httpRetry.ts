/**
 * Side-effect-free `fetch` wrapper adding a per-request timeout and bounded
 * retry-with-backoff for the MCP upstream servers (Metabase, Slack, Google
 * Meet). A hung upstream would otherwise block a tool call indefinitely, and a
 * single transient 429 / 5xx / network blip would fail it outright.
 *
 * Behavior:
 *  - Each attempt is bounded by an AbortController firing after `timeoutMs`.
 *  - Retries (up to `retries` times) on a network error, an aborted timeout,
 *    HTTP 429, or HTTP 5xx. Backoff is exponential: `baseDelayMs * 2^attempt`,
 *    overridden by the upstream `Retry-After` header when present.
 *  - A normal non-ok 4xx (e.g. 404, 403 — anything that is NOT 429) is returned
 *    immediately for the caller to handle; we never retry it.
 *  - On success or a non-retryable response, the `Response` is returned as-is;
 *    the caller still inspects `res.ok` / `res.status` exactly as before.
 *  - After exhausting retries: returns the last failing `Response` if the final
 *    attempt produced one, or throws the last network/timeout error otherwise.
 *
 * `fetchImpl` and `sleep` are injectable so tests can avoid real timers and
 * network. All the servers here only issue reads / auth POSTs, which are safe
 * to retry.
 */

export interface FetchWithRetryOptions {
  /** Per-attempt timeout before the request is aborted. Default 15000ms. */
  timeoutMs?: number;
  /** Max number of RETRIES after the initial attempt. Default 3. */
  retries?: number;
  /** Base backoff; attempt N waits `baseDelayMs * 2^N`. Default 500ms. */
  baseDelayMs?: number;
  /** Injectable fetch (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Injectable delay (defaults to a real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry on rate-limit (429) and server errors (5xx); never on other codes. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form ("120") and an HTTP-date form. Returns `undefined` when
 * absent or unparseable so the caller falls back to exponential backoff.
 */
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (!raw) return undefined;

  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: FetchWithRetryOptions = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;

  // attempt 0 is the initial try; attempts 1..retries are the retries.
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response | undefined;
    try {
      res = await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }

    if (res) {
      // Success or a non-retryable response (incl. normal 4xx like 404): return
      // it for the caller's existing res.ok handling.
      if (!isRetryableStatus(res.status) || attempt === retries) {
        return res;
      }
      // Retryable status with retries remaining: honor Retry-After, else backoff.
      const retryAfterMs = parseRetryAfterMs(res);
      await sleep(retryAfterMs ?? baseDelayMs * 2 ** attempt);
      continue;
    }

    // Network error or timeout abort. Retry if attempts remain.
    if (attempt === retries) break;
    await sleep(baseDelayMs * 2 ** attempt);
  }

  // Exhausted retries with no usable Response — surface the last error.
  throw lastError instanceof Error
    ? lastError
    : new Error(`fetchWithRetry: request to ${url} failed after ${retries + 1} attempts`);
}
