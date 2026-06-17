/**
 * Analytics intent classifier — the cheap pre-call that decides whether a Slack
 * message should be answered by the analytics agent (Atlas brain + Metabase) or
 * the general Sentinel bot.
 *
 * Reuses the shared OpenAI client (gpt-4o-mini) for a single, budget-guarded
 * JSON classification. It is deliberately conservative and FAIL-SAFE: any
 * failure (no API key, budget exhausted, HTTP/parse error, malformed shape)
 * resolves to "general", so routing can never break the existing path — the
 * analytics agent is purely additive.
 *
 * Runs in its own daily-budget bucket so classification traffic can't starve
 * fact extraction, and skips the llm_calls trace (it's a cheap auxiliary call;
 * the analytics REPLY carries the observable prompt_version).
 */

import { extractJson, openaiApiKey, OPENAI_EXTRACT_MODEL } from "../llm/openaiClient.js";
import { ANALYTICS_CLASSIFIER_INSTRUCTIONS } from "../prompts/analytics.js";

export type AnalyticsIntent = "analytics" | "general";

const CLASSIFIER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["analytics", "general"] },
    confidence: { type: "number" },
  },
  required: ["intent"],
  additionalProperties: false,
} as const;

export interface ClassifyOptions {
  /** Override the API key (defaults to the shared OpenAI key). */
  apiKey?: string;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Classify a message as "analytics" or "general". Never throws; returns
 * "general" on any uncertainty or failure.
 */
export async function classifyAnalyticsIntent(
  text: string,
  opts: ClassifyOptions = {}
): Promise<AnalyticsIntent> {
  // Without a key we can't classify — fall back to the general path (safe).
  const apiKey = opts.apiKey ?? openaiApiKey();
  if (!apiKey) return "general";

  const result = await extractJson({
    system: ANALYTICS_CLASSIFIER_INSTRUCTIONS,
    user: text,
    schema: CLASSIFIER_SCHEMA as unknown as Record<string, unknown>,
    model: OPENAI_EXTRACT_MODEL,
    budgetBucket: "classify",
    recordTrace: false,
    maxTokens: 50,
    apiKey,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });

  if (
    result !== null &&
    typeof result === "object" &&
    (result as { intent?: unknown }).intent === "analytics"
  ) {
    return "analytics";
  }
  return "general";
}
