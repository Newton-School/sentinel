import { config } from "./config.js";
import { createLogger } from "./logging/logger.js";
import { getDb, closeDb } from "./state/db.js";
import { getMcpConfigPath, getUnavailableSources } from "./claude/mcpConfig.js";
import { createSlackApp } from "./slack/socketClient.js";
import { fetchThreadContext } from "./slack/threadContext.js";
import { getOrCreatePersona, getTraits } from "./persona/store.js";
import { buildSystemPrompt } from "./claude/systemPrompt.js";
import { runClaude } from "./claude/runner.js";
import { trackQuery } from "./persona/tracker.js";
import { markdownToSlackMrkdwn } from "./slack/formatters.js";
import { startHealthServer, type HealthStatus } from "./health/server.js";
import type { SlackEventEnvelope } from "./types/contracts.js";

const log = createLogger("main");

// Simple semaphore for concurrency limiting
let activeRequests = 0;
const MAX_CONCURRENT = 3;

async function handleEvent(
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
    const unavailableSources = getUnavailableSources();
    const systemPrompt = buildSystemPrompt(persona, traits, unavailableSources);

    // Run Claude
    log.info(
      {
        userId: envelope.userId,
        type: envelope.type,
        textLength: envelope.text.length,
      },
      "Processing request"
    );

    const response = await runClaude(systemPrompt, envelope.text, threadContext);

    // Post response (convert Markdown to Slack mrkdwn)
    const slackText = markdownToSlackMrkdwn(response.text);
    await client.chat.postMessage({
      channel: envelope.channelId,
      thread_ts: envelope.threadTs,
      text: slackText,
      unfurl_links: false,
    });

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

    // Track query for persona evolution and audit logging
    trackQuery({
      userId: envelope.userId,
      channelId: envelope.channelId,
      threadTs: envelope.threadTs,
      queryText: envelope.text,
      responseText: response.text,
      responseDurationMs: response.durationMs,
    });

    log.info(
      { userId: envelope.userId, durationMs: response.durationMs },
      "Request completed"
    );
  } catch (err) {
    log.error({ err, userId: envelope.userId }, "Failed to handle event");

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
    activeRequests--;
  }
}

let slackConnected = false;
const startTime = Date.now();

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
  const allSources = ["Metabase", "GitHub", "Notion", "Slack search", "Gmail", "Google Calendar", "Meeting Transcripts"];
  const activeSources = allSources.filter((s) => !unavailableSources.includes(s));
  startHealthServer(config.HEALTH_CHECK_PORT, (): HealthStatus => {
    let dbStatus: "connected" | "error" = "connected";
    try {
      getDb().prepare("SELECT 1").get();
    } catch {
      dbStatus = "error";
    }

    const isOk = slackConnected && dbStatus === "connected";
    return {
      status: isOk ? "ok" : "degraded",
      uptime: Math.floor((Date.now() - startTime) / 1000),
      slack: slackConnected ? "connected" : "disconnected",
      database: dbStatus,
      mcpServers: activeSources,
      unavailableSources,
    };
  });

  // Start Slack app
  const app = createSlackApp(handleEvent);
  await app.start();
  slackConnected = true;
  log.info("Slack Socket Mode connected — Sentinel is ready");
}

main().catch((err) => {
  log.fatal({ err }, "Fatal error during startup");
  closeDb();
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  log.info("Received SIGINT, shutting down");
  closeDb();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log.info("Received SIGTERM, shutting down");
  closeDb();
  process.exit(0);
});
