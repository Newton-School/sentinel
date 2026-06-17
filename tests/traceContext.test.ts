import { describe, it, expect } from "vitest";
import { runWithTrace, currentTrace, newTraceId } from "../src/llm/traceContext.js";

describe("traceContext", () => {
  it("returns undefined outside any trace scope", () => {
    expect(currentTrace()).toBeUndefined();
  });

  it("exposes the trace id + user inside runWithTrace, and clears after", () => {
    const out = runWithTrace({ traceId: "T1", userId: "U1" }, () => {
      expect(currentTrace()?.traceId).toBe("T1");
      expect(currentTrace()?.userId).toBe("U1");
      return 42;
    });
    expect(out).toBe(42); // run() returns the callback's value
    expect(currentTrace()).toBeUndefined();
  });

  it("newTraceId returns unique, non-empty ids", () => {
    const a = newTraceId();
    const b = newTraceId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });

  it("propagates the trace across a detached/awaited async continuation", async () => {
    // Mirrors src/index.ts: a fire-and-forget IIFE launched synchronously
    // inside the trace scope must inherit the trace id across awaits.
    let inflight: Promise<void> = Promise.resolve();
    let seen: string | undefined;
    runWithTrace({ traceId: "T2" }, () => {
      inflight = (async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 1));
        seen = currentTrace()?.traceId;
      })();
    });
    await inflight;
    expect(seen).toBe("T2");
  });

  it("isolates concurrent traces", async () => {
    const results: Record<string, string | undefined> = {};
    await Promise.all([
      runWithTrace({ traceId: "A" }, async () => {
        await new Promise((r) => setTimeout(r, 2));
        results.A = currentTrace()?.traceId;
      }),
      runWithTrace({ traceId: "B" }, async () => {
        await new Promise((r) => setTimeout(r, 1));
        results.B = currentTrace()?.traceId;
      }),
    ]);
    expect(results.A).toBe("A");
    expect(results.B).toBe("B");
  });
});
