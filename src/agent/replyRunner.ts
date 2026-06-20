import { config } from "../config.js";
import type { ViewerScope } from "../access/scope.js";
import type { ClaudeResponse } from "../types/contracts.js";
import { runClaude } from "../claude/runner.js";
import { runAgentReply, type RunReplyOptions } from "./runner.js";

export type { RunReplyOptions };

/**
 * Reply-runner dispatcher. Selects the agentic backend by `config.HARNESS`:
 *   'openai' → the in-process OpenAI Agents SDK loop (runAgentReply)
 *   'cli'    → the legacy Claude CLI subprocess (runClaude)
 *
 * Both backends share the runClaude() signature and the ClaudeResponse
 * contract, so call sites (src/index.ts, evals/analyticsEval.ts) are unchanged
 * — they just import runReply instead of runClaude. The flag lets both paths
 * coexist for an eval-gated, reversible cutover.
 */
export function runReply(
  systemPrompt: string,
  userMessage: string,
  threadContext?: string,
  viewer?: ViewerScope,
  promptVersion?: string,
  options?: RunReplyOptions
): Promise<ClaudeResponse> {
  if (config.HARNESS === "openai") {
    return runAgentReply(systemPrompt, userMessage, threadContext, viewer, promptVersion, options);
  }
  return runClaude(systemPrompt, userMessage, threadContext, viewer, promptVersion, options);
}
