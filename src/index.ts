import { config } from "./config.js";
import { createLogger } from "./logging/logger.js";
import { getDb, closeDb } from "./state/db.js";
import { getMcpConfigPath, getUnavailableSources, cleanupMcpConfig } from "./claude/mcpConfig.js";
import { createSlackApp } from "./slack/socketClient.js";
import { fetchThreadContext } from "./slack/threadContext.js";
import { getOrCreatePersona, getTraits } from "./persona/store.js";
import { searchMemories, assembleRetrieval, currentViewerScope } from "./memory/memoryStore.js";
import { isEntityGraphEnabled } from "./memory/entityLink.js";
import { isEmbeddingsEnabled } from "./memory/embeddingBackfill.js";
import { embedText } from "./memory/embedder.js";
import { openaiApiKey } from "./llm/openaiClient.js";
import { extractFromConversation } from "./memory/conversationHook.js";
import { runWithTrace, newTraceId, currentTrace } from "./llm/traceContext.js";
import { activePromptVersionId } from "./prompts/registry.js";
import { recordReply, recordFeedback, recordButtonFeedback, isFeedbackEnabled } from "./feedback/store.js";
import type { ReactionEnvelope, FeedbackActionEnvelope } from "./slack/socketClient.js";
import { buildReplyBlocks, acknowledgedBlocks, type Block } from "./slack/feedbackBlocks.js";
import { buildSystemPrompt } from "./claude/systemPrompt.js";
import type { RankedMemory, RetrievalBundle } from "./memory/types.js";
import { runClaude } from "./claude/runner.js";
import { trackQuery } from "./persona/tracker.js";
import { slackReplyText } from "./slack/formatters.js";
import { startHealthServer, type HealthStatus } from "./health/server.js";
import { record, renderPrometheus } from "./metrics/registry.js";
import { renderEvalGauges } from "./metrics/evalGauges.js";
import { startMeetWatcher } from "./meet-bot/watcher.js";
import { startIngestWatcher } from "./memory/ingestWatcher.js";
import { startConsolidationWatcher } from "./memory/consolidationWatcher.js";
import { createGracefulShutdown } from "./shutdown.js";
import type { SlackEventEnvelope } from "./types/contracts.js";
import type http from "node:http";

const log = createLogger("main");

// Simple semaphore for concurrency limiting
let activeRequests = 0;
const MAX_CONCURRENT = 3;

/**
 * Establishes a per-request LLM trace, then handles the event. Every LLM call
 * in the fan-out — the Claude reply AND the fire-and-forget fact extraction
 * launched in the `finally` (which inherits this AsyncLocalStorage scope) —
 * records an `llm_calls` row sharing this trace id.
 */
async function handleEvent(
  envelope: SlackEventEnvelope,
  client: Parameters<import("./slack/socketClient.js").EventHandler>[1]
): Promise<void> {
  return runWithTrace(
    { traceId: newTraceId(), userId: envelope.userId },
    () => handleEventInner(envelope, client)
  );
}

async function handleEventInner(
  envelope: SlackEventEnvelope,
  client: Parameters<import("./slack/socketClient.js").EventHandler>[1]
): Promise<void> {
  if (activeRequests >= MAX_CONCURRENT) {
    await client.chat.postMessage({
      channel: envelope.channelId,
      thread_ts: envelope.threadTs,
      text: ":hourglass: I'm handling several requests right now. Please wait a moment...",
    });
    return;
  }

  activeRequests++;
  // Wall-clock start for the error-path metric (the success path uses the
  // CLI-measured response.durationMs instead).
  const requestStart = Date.now();
  // Hoisted so the post-reply fact extraction in `finally` runs whether or not
  // the answer succeeded — a timed-out/failed answer must still capture durable
  // facts from the user's message.
  let memories: RankedMemory[] = [];
  let responseText = "";
  try {
    // Add :eyes: reaction
    try {
      await client.reactions.add({
        channel: envelope.channelId,
        timestamp: envelope.messageTs,
        name: "eyes",
      });
    } catch {
      // Reaction may fail if already added or no permission
    }

    // Fetch thread context
    const threadMessages = await fetchThreadContext(
      client,
      envelope.channelId,
      envelope.threadTs
    );

    let threadContext: string | undefined;
    if (threadMessages.length > 0) {
      threadContext = threadMessages
        .map((m) => `<@${m.userId}>: ${m.text}`)
        .join("\n");
    }

    // Look up user info for persona
    let displayName = envelope.userId;
    try {
      const userInfo = await client.users.info({ user: envelope.userId });
      displayName =
        userInfo.user?.real_name ??
        userInfo.user?.name ??
        envelope.userId;
    } catch {
      // Fall back to user ID
    }

    // Load/create persona and build system prompt
    const persona = getOrCreatePersona(envelope.userId, displayName);
    const traits = getTraits(envelope.userId);

    // Recall relevant organizational memories for this query. Best-effort:
    // searchMemories already swallows internal errors, and this try/catch is
    // belt-and-braces — a memory failure must NEVER fail the reply.
    // Thread the asker's scope through the canView ACL seam. In founders mode
    // (default) every allowed user is a founder and sees all rows — equivalent
    // to the prior behaviour. When the entity graph is enabled, use the
    // entity-aware bundle (query facts + facts about entities named in the
    // query); otherwise the flat keyword recall. Best-effort: a memory failure
    // must NEVER fail the reply.
    // The asker's scope — used for recall filtering AND threaded into the
    // memory MCP server (so canView applies at the MCP edge too).
    const viewer = currentViewerScope(envelope.userId);
    let bundle: RetrievalBundle | undefined;
    try {
      if (isEntityGraphEnabled()) {
        // Hybrid recall: embed the query for the semantic pass when enabled
        // (best-effort — a null vector falls back to BM25-only inside).
        let queryVec: Float32Array | undefined;
        if (isEmbeddingsEnabled()) {
          queryVec =
            (await embedText(envelope.text, {
              apiKey: openaiApiKey(),
              model: config.MEMORY_EMBEDDING_MODEL,
            })) ?? undefined;
        }
        bundle = assembleRetrieval(envelope.text, envelope.userId, viewer, queryVec);
      } else {
        memories = searchMemories(envelope.text, 6, viewer);
      }
    } catch {
      // Never fail the reply over memory recall.
    }

    const unavailableSources = getUnavailableSources();
    const systemPrompt = buildSystemPrompt(persona, traits, unavailableSources, memories, bundle);

    // Run Claude
    log.info(
      {
        userId: envelope.userId,
        type: envelope.type,
        textLength: envelope.text.length,
      },
      "Processing request"
    );

    const response = await runClaude(
      systemPrompt,
      envelope.text,
      threadContext,
      viewer,
      activePromptVersionId("system")
    );
    responseText = response.text ?? "";

    // Post response (convert Markdown to Slack mrkdwn; never post an empty
    // message — an empty/looped Claude result falls back to a notice).
    const slackText = slackReplyText(response.text);
    const feedbackOn = isFeedbackEnabled();
    // When feedback is on, render the answer with 👍/👎 buttons (trace id rides
    // on each button so a click is attributable). `text` stays as the fallback.
    const posted = await client.chat.postMessage({
      channel: envelope.channelId,
      thread_ts: envelope.threadTs,
      text: slackText,
      unfurl_links: false,
      ...(feedbackOn ? { blocks: buildReplyBlocks(slackText, currentTrace()?.traceId ?? "") } : {}),
    });

    // Remember this reply so a later 👍/👎 vote can be attributed to its trace
    // (and harvested into eval datasets). Best-effort, gated on the flag.
    if (feedbackOn && posted.ts) {
      try {
        recordReply({
          channelId: envelope.channelId,
          replyTs: posted.ts,
          traceId: currentTrace()?.traceId,
          userId: envelope.userId,
          question: envelope.text,
          answer: response.text,
        });
      } catch (err) {
        log.error({ err }, "Failed to record bot reply for feedback (non-fatal)");
      }
    }

    // Swap :eyes: for :white_check_mark:
    try {
      await client.reactions.remove({
        channel: envelope.channelId,
        timestamp: envelope.messageTs,
        name: "eyes",
      });
      await client.reactions.add({
        channel: envelope.channelId,
        timestamp: envelope.messageTs,
        name: "white_check_mark",
      });
    } catch {
      // Reaction management is best-effort
    }

    // Track query for persona evolution and audit logging.
    trackQuery({
      userId: envelope.userId,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
      queryText: envelope.text,
      responseText: response.text,
      responseDurationMs: response.durationMs,
    });

    // Record ops metrics for /metrics (token/cost only present when the CLI
    // JSON telemetry was parsed).
    record({
      type: envelope.type,
      durationMs: response.durationMs,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      costUsd: response.costUsd,
    });

    log.info(
      { userId: envelope.userId, durationMs: response.durationMs },
      "Request completed"
    );
  } catch (err) {
    log.error({ err, userId: envelope.userId }, "Failed to handle event");

    // Record the failed request (wall-clock duration; no token/cost telemetry).
    record({
      type: envelope.type,
      durationMs: Date.now() - requestStart,
      isError: true,
    });

    const errorMessage =
      err instanceof Error && err.message.includes("timed out")
        ? ":warning: The request timed out — the query may have been too complex or a data source was slow. Try a more specific question."
        : ":warning: Sorry, I hit an error processing that request. Please try again.";

    try {
      await client.reactions.remove({
        channel: envelope.channelId,
        timestamp: envelope.messageTs,
        name: "eyes",
      });
    } catch {
      // May not have been added
    }

    try {
      await client.reactions.add({
        channel: envelope.channelId,
        timestamp: envelope.messageTs,
        name: "x",
      });
      await client.chat.postMessage({
        channel: envelope.channelId,
        thread_ts: envelope.threadTs,
        text: errorMessage,
      });
    } catch {
      // Best effort error reporting
    }
  } finally {
    // Fire-and-forget fact extraction from this exchange — runs on BOTH the
    // success and failure paths (a timed-out answer must still capture durable
    // facts). User-turn-grounded: only `envelope.text` can evidence a fact; the
    // bot's reply is disambiguation context only. Never awaited, never throws.
    extractFromConversation({
      queryText: envelope.text,
      responseText,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
      injectedMemories: memories.map((m) => m.text),
    });
    activeRequests--;
  }
}

/**
 * Records a 👍/👎 reaction on a bot reply as feedback. Best-effort: a feedback
 * failure must never disrupt the bot. Reactions on non-bot messages are no-ops
 * (recordFeedback only writes when the reply is tracked in bot_replies).
 */
async function handleReaction(env: ReactionEnvelope): Promise<void> {
  try {
    recordFeedback({
      channelId: env.channelId,
      replyTs: env.itemTs,
      reactorUserId: env.reactorUserId,
      reaction: env.reaction,
      addedAtIso: new Date().toISOString(),
    });
  } catch (err) {
    log.error({ err }, "Failed to record feedback (non-fatal)");
  }
}

/**
 * Records a 👍/👎 feedback-button click, then swaps the buttons for a
 * thank-you note so the vote is confirmed and can't be re-clicked. Best-effort.
 */
async function handleFeedbackAction(
  env: FeedbackActionEnvelope,
  client: Parameters<import("./slack/socketClient.js").EventHandler>[1]
): Promise<void> {
  try {
    const recorded = recordButtonFeedback({
      channelId: env.channelId,
      replyTs: env.replyTs,
      reactorUserId: env.reactorUserId,
      sentiment: env.sentiment,
      addedAtIso: new Date().toISOString(),
    });
    if (recorded && Array.isArray(env.messageBlocks)) {
      await client.chat.update({
        channel: env.channelId,
        ts: env.replyTs,
        text: "Thanks for your feedback.",
        blocks: acknowledgedBlocks(env.messageBlocks as Block[], env.sentiment, env.reactorUserId),
      });
    }
  } catch (err) {
    log.error({ err }, "Failed to record feedback action (non-fatal)");
  }
}

let slackConnected = false;
const startTime = Date.now();

// Module-scope handles assigned in main(), consumed by the shutdown sequence.
let slackApp: ReturnType<typeof createSlackApp> | null = null;
let stopWatcher: (() => void) | null = null;
let stopIngest: (() => void) | null = null;
let stopConsolidation: (() => void) | null = null;
let healthServer: http.Server | null = null;

async function main(): Promise<void> {
  log.info("Starting Sentinel");

  // Initialize database
  getDb();
  log.info("Database initialized");

  // Generate MCP config
  getMcpConfigPath();
  log.info("MCP config generated");

  // Start health check server
  const unavailableSources = getUnavailableSources();
  const allSources = ["Metabase", "GitHub", "Notion", "Slack search", "Gmail", "Google Calendar", "Meeting Transcripts", "Google Meet", "Memory"];
  const activeSources = allSources.filter((s) => !unavailableSources.includes(s));
  const uptimeSeconds = (): number =>
    Math.floor((Date.now() - startTime) / 1000);

  // Readiness (/ready): probes Slack connectivity + a DB SELECT 1. All
  // degradation lives here. Liveness (/health) deliberately does NOT call this
  // — see the uptime provider below — so a slow Socket Mode connect or a
  // transient SQLite blip cannot flip /health to 503 and trigger a restart loop.
  healthServer = startHealthServer(
    config.HEALTH_CHECK_PORT,
    (): HealthStatus => {
      let dbStatus: "connected" | "error" = "connected";
      try {
        getDb().prepare("SELECT 1").get();
      } catch {
        dbStatus = "error";
      }

      const isOk = slackConnected && dbStatus === "connected";
      return {
        status: isOk ? "ok" : "degraded",
        uptime: uptimeSeconds(),
        slack: slackConnected ? "connected" : "disconnected",
        database: dbStatus,
        mcpServers: activeSources,
        unavailableSources,
      };
    },
    // Liveness uptime: cheap, no Slack/DB dependency.
    uptimeSeconds,
    // /metrics: in-process request/token/cost/feedback counters, plus eval
    // pass-rate gauges read from eval_runs at scrape time.
    () => renderPrometheus() + renderEvalGauges()
  );

  // Start Meet watcher (auto-joins upcoming meetings via Playwright bot)
  stopWatcher = startMeetWatcher();

  // Start memory ingest watcher (Meet transcripts + internal Gmail → memory)
  stopIngest = startIngestWatcher();

  // Start consolidation watcher (rolls entity facts into dossiers).
  stopConsolidation = startConsolidationWatcher();

  // Start Slack app. When feedback is enabled, wire both the button-action
  // handler (primary) and the reaction handler (secondary — both write feedback).
  const feedbackOn = isFeedbackEnabled();
  const app = createSlackApp(
    handleEvent,
    feedbackOn ? handleReaction : undefined,
    feedbackOn ? handleFeedbackAction : undefined
  );
  slackApp = app;
  await app.start();
  slackConnected = true;
  log.info("Slack Socket Mode connected — Sentinel is ready");
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error during startup");
  closeDb();
  process.exit(1);
});

// Graceful shutdown: stop the watcher poll loop, stop accepting new Slack
// events, drain in-flight requests, close the health server + DB, then exit.
// Already-detached Meet joiner subprocesses are intentionally left running.
const shutdown = createGracefulShutdown({
  stopWatcher: () => {
    stopWatcher?.();
    stopIngest?.();
    stopConsolidation?.();
  },
  stopSlackApp: async () => {
    if (slackApp) await slackApp.stop();
  },
  closeHealthServer: () =>
    new Promise<void>((resolve) => {
      if (!healthServer) {
        resolve();
        return;
      }
      healthServer.close(() => resolve());
    }),
  closeDb: () => {
    closeDb();
    cleanupMcpConfig();
  },
  getActiveRequests: () => activeRequests,
  exit: (code) => process.exit(code),
  log,
});

process.on("SIGINT", (signal) => void shutdown(signal));
process.on("SIGTERM", (signal) => void shutdown(signal));
