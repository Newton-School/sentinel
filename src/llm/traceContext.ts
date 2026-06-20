/**
 * Request-scoped LLM trace propagation via AsyncLocalStorage (ALS).
 *
 * One Slack request fans out into the agent reply plus several in-process OpenAI
 * calls (query embedding, then the fire-and-forget fact extraction + its
 * embeddings). All of these run IN-PROCESS, so an ALS store established at the
 * top of `handleEvent` is inherited by every downstream call — including the
 * detached extraction launched in the `finally` block — with no need to thread
 * a trace id through every function signature.
 *
 * The agent reply runs in-process (OpenAI Agents SDK), so it too is covered by
 * the ALS scope. The `reply` span is still recorded as one aggregate row for the
 * whole run (the loop's total usage); per-tool-call spans are not broken out.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export interface TraceContext {
  /** Request-scoped id shared across every LLM call in this request's fan-out. */
  traceId: string;
  /** The Slack user who triggered the request, when known. */
  userId?: string;
}

const als = new AsyncLocalStorage<TraceContext>();

/** Runs `fn` with `ctx` as the active trace; returns `fn`'s result. */
export function runWithTrace<T>(ctx: TraceContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** The active trace context, or `undefined` outside any `runWithTrace` scope. */
export function currentTrace(): TraceContext | undefined {
  return als.getStore();
}

/** A fresh, collision-free trace id (matches the UUID usage in mcpConfig.ts). */
export function newTraceId(): string {
  return randomUUID();
}
