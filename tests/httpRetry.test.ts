import { describe, it, expect, vi } from "vitest";
import { fetchWithRetry } from "../src/mcp/httpRetry.js";

/**
 * Build a Response-like fake for the injected fetch mock. Mirrors the shape used
 * by the metabaseClient tests so the helper exercises real-ish Response objects.
 */
function fakeResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
}): Response {
  const status = opts.status ?? 200;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  const headerMap = opts.headers ?? {};
  return {
    ok,
    status,
    statusText: opts.statusText ?? "",
    headers: {
      get: (name: string) => headerMap[name.toLowerCase()] ?? headerMap[name] ?? null,
    },
  } as unknown as Response;
}

/** No-op sleep that records the delays it was asked to wait. */
function recordingSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

describe("fetchWithRetry", () => {
  it("returns the response on first-try success with a single call", async () => {
    const res = fakeResponse({ ok: true, status: 200 });
    const fetchImpl = vi.fn(async () => res);
    const { sleep } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    expect(out).toBe(res);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries on 429 then succeeds (2 calls, backoff slept)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 429 }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep, delays } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 10,
    });

    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // First backoff = baseDelayMs * 2^0 = 10.
    expect(delays[0]).toBe(10);
  });

  it("retries on 503 (5xx) then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 5,
    });

    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("retries on a network error then succeeds on retry", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 5,
    });

    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("uses exponential backoff across multiple retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 500 }))
      .mockResolvedValueOnce(fakeResponse({ ok: false, status: 500 }))
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep, delays } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 10,
      retries: 3,
    });

    expect(out.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // baseDelayMs * 2^0 then baseDelayMs * 2^1.
    expect(delays).toEqual([10, 20]);
  });

  it("returns the last failing response after exhausting retries on 5xx", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 503 }));
    const { sleep } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 1,
      retries: 2,
    });

    // Contract: the final failing Response is returned (caller checks res.ok).
    expect(out.status).toBe(503);
    expect(out.ok).toBe(false);
    // Initial attempt + 2 retries = 3 calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // Slept before each of the 2 retries.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("throws the network error after exhausting retries", async () => {
    const netErr = new Error("ECONNREFUSED");
    const fetchImpl = vi.fn(async () => {
      throw netErr;
    });
    const { sleep } = recordingSleep();

    await expect(
      fetchWithRetry("http://x.test", undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        baseDelayMs: 1,
        retries: 2,
      })
    ).rejects.toThrow("ECONNREFUSED");

    // Initial attempt + 2 retries = 3 calls.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns a normal 404 (4xx, not 429) immediately without retry", async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ ok: false, status: 404 }));
    const { sleep } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      retries: 3,
    });

    expect(out.status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors Retry-After (seconds) when present on a 429", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ ok: false, status: 429, headers: { "retry-after": "2" } })
      )
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep, delays } = recordingSleep();

    const out = await fetchWithRetry("http://x.test", undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      baseDelayMs: 10,
    });

    expect(out.status).toBe(200);
    // Retry-After of 2s overrides the 10ms backoff -> 2000ms.
    expect(delays[0]).toBe(2000);
  });

  it("aborts a hung request via the timeout and retries", async () => {
    // First call hangs until its AbortSignal fires, then rejects (mimics fetch
    // honoring the AbortController). Second call succeeds.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal) {
              signal.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError"))
              );
            }
          })
      )
      .mockResolvedValueOnce(fakeResponse({ ok: true, status: 200 }));
    const { sleep } = recordingSleep();

    vi.useFakeTimers();
    try {
      const promise = fetchWithRetry("http://x.test", undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        timeoutMs: 50,
        baseDelayMs: 1,
        retries: 2,
      });
      // Advance past the timeout so the AbortController fires on attempt 1.
      await vi.advanceTimersByTimeAsync(60);
      // Let the retry resolve.
      await vi.advanceTimersByTimeAsync(10);
      const out = await promise;
      expect(out.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws a timeout error after exhausting retries on persistent hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError"))
            );
          }
        })
    );
    const { sleep } = recordingSleep();

    vi.useFakeTimers();
    try {
      const promise = fetchWithRetry("http://x.test", undefined, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        timeoutMs: 50,
        baseDelayMs: 1,
        retries: 1,
      }).catch((e) => e as Error);
      // Drive both attempts to time out. sleep is a no-op so backoff resolves
      // immediately; advancing timers fires each attempt's AbortController.
      await vi.advanceTimersByTimeAsync(60);
      await vi.advanceTimersByTimeAsync(60);
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      // Initial attempt + 1 retry = 2 calls.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
