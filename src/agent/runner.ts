import { Agent, Runner, setDefaultOpenAIKey, setTracingDisabled } from "@openai/agents";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { recordLlmCall } from "../llm/traceStore.js";
import { computeCostUsd } from "../llm/modelPricing.js";
import { openaiApiKey } from "../llm/openaiClient.js";
import { buildMcpServers } from "./mcpServers.js";
import type { ViewerScope } from "../access/scope.js";
import type { ClaudeResponse } from "../types/contracts.js";
import type { RunClaudeOptions } from "../claude/runner.js";

const log = createLogger("agent-runner");

const TIMEOUT_MS = 180_000; // matches the legacy CLI runner's default window

/**
 * Per-call overrides for the OpenAI Agents SDK reply loop. Extends the legacy
 * CLI options with agent-loop cost guards so call sites keep passing the same
 * options object.
 */
export interface RunReplyOptions extends RunClaudeOptions {
  /** Hard cap on agent turns (tool-call rounds). Defaults to config.AGENT_MAX_TURNS. */
  maxTurns?: number;
  /** Cumulative output-token budget; reserved for Phase 3 guardrails. */
  tokenBudget?: number;
}

// One-time SDK init: route the agent loop through Sentinel's OpenAI key and
// disable the SDK's default trace export (no data egress to the OpenAI
// platform). Idempotent — only the first reply pays for it.
let sdkInitialized = false;
function ensureSdkInitialized(): void {
  if (sdkInitialized) return;
  const key = openaiApiKey();
  if (key) setDefaultOpenAIKey(key);
  setTracingDisabled(true);
  sdkInitialized = true;
}

/** Test hook: re-arm the one-time SDK init so init can be asserted. */
export function __resetAgentRunnerForTests(): void {
  sdkInitialized = false;
}

/**
 * Eagerly initialize the OpenAI Agents SDK (key + tracing-off) at boot, so a
 * configuration problem surfaces at startup and the first reply doesn't pay the
 * init. Returns true when an OpenAI key was found. Safe to call repeatedly.
 */
export function initAgentHarness(): boolean {
  ensureSdkInitialized();
  return Boolean(openaiApiKey());
}

interface AgentUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Defensively read the aggregated run usage (state.usage, with a context fallback). */
function readUsage(result: unknown): AgentUsage | undefined {
  const r = result as { state?: { usage?: AgentUsage }; runContext?: { usage?: AgentUsage } };
  return r?.state?.usage ?? r?.runContext?.usage;
}

/**
 * The OpenAI-harness reply runner. Contract-compatible with runClaude(): it
 * builds an Agent over per-request stdio MCP servers, runs the agentic loop on
 * the OpenAI API, and maps the result into a ClaudeResponse.
 *
 * MCP servers (including the per-request memory server carrying this viewer's
 * ACL scope) are connected before the run and closed in `finally` — they never
 * outlive the request, which is what keeps one user's viewer scope from leaking
 * into another's reply (see mcpServers.resolveServerSpecs).
 */
export async function runAgentReply(
  systemPrompt: string,
  userMessage: string,
  threadContext?: string,
  viewer?: ViewerScope,
  promptVersion?: string,
  options?: RunReplyOptions
): Promise<ClaudeResponse> {
  ensureSdkInitialized();

  const start = Date.now();
  const model = options?.model ?? config.OPENAI_REPLY_MODEL;
  const maxTurns = options?.maxTurns ?? config.AGENT_MAX_TURNS;
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;
  const timeoutEnabled = timeoutMs > 0;
  // Cumulative-token cost guard (cost runaway protection on top of maxTurns).
  const tokenBudget = options?.tokenBudget ?? config.AGENT_TOKEN_BUDGET;

  const fullPrompt = threadContext
    ? `${threadContext}\n\nLatest message:\n${userMessage}`
    : userMessage;

  const servers = buildMcpServers({
    ...(viewer ? { viewer } : {}),
    ...(options?.mcpServers ? { servers: options.mcpServers } : {}),
  });

  // timeoutMs <= 0 disables the timeout entirely (the analytics route's
  // projection skills legitimately run longer than the default window).
  const abort = new AbortController();
  let timedOut = false;
  let budgetExceeded = false;
  const timer = timeoutEnabled
    ? setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, timeoutMs)
    : undefined;

  // Record exactly one openai `reply` span for this invocation. Best-effort:
  // a sink failure must never break the reply.
  let spanRecorded = false;
  const recordReply = (
    status: "ok" | "error",
    usage?: AgentUsage,
    errorKind?: string
  ): void => {
    if (spanRecorded) return;
    spanRecorded = true;
    try {
      recordLlmCall({
        provider: "openai",
        model,
        operation: "reply",
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        costUsd: usage
          ? computeCostUsd(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0)
          : undefined,
        latencyMs: Date.now() - start,
        numTurns: usage?.requests,
        status,
        errorKind,
        promptVersion,
      });
    } catch {
      /* telemetry must never break the reply */
    }
  };

  // Connect each server; a server that fails to connect is logged and skipped
  // (graceful degradation — its tools are simply unavailable, mirroring the CLI
  // path where a broken server just doesn't surface tools).
  const connected: typeof servers = [];
  await Promise.all(
    servers.map(async (s) => {
      try {
        await s.connect();
        connected.push(s);
      } catch (err) {
        log.warn({ err, server: s.name }, "MCP server failed to connect — skipping");
      }
    })
  );

  log.info(
    { promptLength: fullPrompt.length, model, maxTurns, servers: connected.length },
    "Running OpenAI agent"
  );

  try {
    const agent = new Agent({
      name: "Sentinel",
      instructions: systemPrompt,
      model,
      mcpServers: connected,
    });

    // A Runner (rather than the functional run()) lets us attach a token-budget
    // hook. agent_tool_start fires before each tool call — i.e. after the model
    // produced its latest usage — so aborting there stops further (expensive)
    // turns once cumulative usage crosses the budget.
    const runner = new Runner();
    if (tokenBudget && tokenBudget > 0) {
      runner.on("agent_tool_start", (ctx: { usage?: { totalTokens?: number } }) => {
        const used = ctx?.usage?.totalTokens ?? 0;
        if (used >= tokenBudget) {
          budgetExceeded = true;
          abort.abort();
        }
      });
    }

    const result = await runner.run(agent, fullPrompt, {
      maxTurns,
      // The budget hook needs a signal to abort even when no timeout is set.
      ...(timeoutEnabled || (tokenBudget && tokenBudget > 0) ? { signal: abort.signal } : {}),
    });

    const usage = readUsage(result);
    const text = String(result.finalOutput ?? "");
    const durationMs = Date.now() - start;

    const response: ClaudeResponse = { text, durationMs };
    if (usage?.inputTokens !== undefined) response.inputTokens = usage.inputTokens;
    if (usage?.outputTokens !== undefined) response.outputTokens = usage.outputTokens;
    const cost = usage
      ? computeCostUsd(model, usage.inputTokens ?? 0, usage.outputTokens ?? 0)
      : undefined;
    if (cost !== undefined) response.costUsd = cost;
    if (usage?.requests !== undefined) response.numTurns = usage.requests;

    log.info(
      {
        durationMs,
        responseLength: text.length,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: response.costUsd,
        numTurns: response.numTurns,
      },
      "OpenAI agent completed"
    );
    recordReply("ok", usage);
    return response;
  } catch (err) {
    // Preserve the timeout contract: index.ts keys its user-facing timeout copy
    // on the substring "timed out".
    if (timedOut) {
      recordReply("error", undefined, "timeout");
      throw new Error(`OpenAI agent timed out after ${timeoutMs}ms`);
    }
    if (budgetExceeded) {
      recordReply("error", undefined, "budget");
      throw new Error(`OpenAI agent stopped: token budget (${tokenBudget}) exceeded`);
    }
    recordReply("error", undefined, "run");
    log.error({ err }, "OpenAI agent run failed");
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timer) clearTimeout(timer);
    // Tear down every spawned stdio child (incl. the per-request memory server).
    await Promise.allSettled(connected.map((s) => s.close()));
  }
}
