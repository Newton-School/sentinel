/**
 * Routing decision for an incoming message: analytics vs general.
 *
 * The LLM intent classifier decides. Projection requests ("run the M0 RFD
 * projection for May") route to analytics like any other data question — the
 * Atlas brain already carries the §16/§17 skill procedures (trigger phrases +
 * "execute autonomously"), so the analytics agent runs them. Pure and
 * config-free; routing is always on (called for every message).
 */

import { classifyAnalyticsIntent, type ClassifyOptions } from "./classifier.js";

export type RouteDecision = { kind: "analytics" } | { kind: "general" };

export async function decideRoute(
  text: string,
  opts?: ClassifyOptions
): Promise<RouteDecision> {
  const intent = await classifyAnalyticsIntent(text, opts);
  return intent === "analytics" ? { kind: "analytics" } : { kind: "general" };
}
