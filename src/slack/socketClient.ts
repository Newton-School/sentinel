import bolt from "@slack/bolt";
const { App } = bolt;
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import type { SlackEventEnvelope } from "../types/contracts.js";

const log = createLogger("slack");

export type EventHandler = (
  envelope: SlackEventEnvelope,
  client: InstanceType<typeof App>["client"]
) => Promise<void>;

/**
 * Authorization gate. Returns true only when `userId` is in the allow-list.
 * Security-critical: this is the single check that keeps non-listed Slack
 * users from reaching the bot.
 */
export function isAllowed(userId: string): boolean {
  return config.ALLOWED_USER_IDS.includes(userId);
}

/**
 * Removes a leading/embedded `<@BOT_USER_ID>` mention (and surrounding
 * whitespace) from `app_mention` text. Text without the mention is unchanged
 * (aside from trimming).
 */
export function stripBotMention(text: string): string {
  return text.replace(new RegExp(`<@${config.BOT_USER_ID}>`, "g"), "").trim();
}

/**
 * Predicate used by the DM handler to decide whether a `message` event is a
 * genuine user query. Filters out non-DM channels, any message subtype (edits,
 * joins, deletions, bot postbacks), messages with no user, and the bot's own
 * messages.
 */
export function isUserDmMessage(msg: Record<string, unknown>): boolean {
  if (msg.channel_type !== "im" || msg.subtype) return false;
  const userId = msg.user as string | undefined;
  if (!userId || userId === config.BOT_USER_ID) return false;
  return true;
}

/** Normalize an `app_mention` event into a SlackEventEnvelope. */
export function normalizeMention(event: {
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}): SlackEventEnvelope {
  const threadTs = event.thread_ts ?? event.ts;
  return {
    type: "mention",
    userId: event.user,
    channelId: event.channel,
    threadTs,
    text: stripBotMention(event.text),
    messageTs: event.ts,
  };
}

/** Normalize a DM `message` event into a SlackEventEnvelope. */
export function normalizeDmMessage(
  msg: Record<string, unknown>
): SlackEventEnvelope {
  const threadTs =
    (msg.thread_ts as string | undefined) ?? (msg.ts as string);
  return {
    type: "dm",
    userId: msg.user as string,
    channelId: msg.channel as string,
    threadTs,
    text: (msg.text as string) ?? "",
    messageTs: msg.ts as string,
  };
}

/** Normalize a `/sentinel` slash command into a SlackEventEnvelope. */
export function normalizeSlashCommand(
  command: { user_id: string; channel_id: string; text: string },
  resultTs: string
): SlackEventEnvelope {
  return {
    type: "slash_command",
    userId: command.user_id,
    channelId: command.channel_id,
    threadTs: resultTs,
    text: command.text || "What can I help with?",
    messageTs: resultTs,
  };
}

export function createSlackApp(handler: EventHandler) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: bolt.LogLevel.WARN,
  });

  // Handle @mentions
  app.event("app_mention", async ({ event, client }) => {
    const userId = event.user;
    if (!userId || !isAllowed(userId)) {
      log.warn({ userId }, "Unauthorized or unknown user, ignoring mention");
      return;
    }

    const envelope = normalizeMention({
      user: userId,
      text: event.text,
      channel: event.channel,
      ts: event.ts,
      thread_ts: event.thread_ts,
    });

    await handler(envelope, client);
  });

  // Handle DMs — use the message shortcut which properly types GenericMessageEvent
  app.message(async ({ message, client }) => {
    // Cast to access properties — Bolt's message types are a complex union
    const msg = message as unknown as Record<string, unknown>;

    // Only handle plain user messages in DMs (no subtype, not the bot).
    if (!isUserDmMessage(msg)) return;

    const userId = msg.user as string;
    if (!isAllowed(userId)) {
      log.warn({ userId }, "Unauthorized user, ignoring DM");
      return;
    }

    const envelope = normalizeDmMessage(msg);

    await handler(envelope, client);
  });

  // Handle /sentinel slash command
  app.command("/sentinel", async ({ command, ack, client }) => {
    await ack();

    if (!isAllowed(command.user_id)) {
      log.warn(
        { userId: command.user_id },
        "Unauthorized user, ignoring command"
      );
      return;
    }

    // Post an initial message to create a thread
    const result = await client.chat.postMessage({
      channel: command.channel_id,
      text: `:satellite_antenna: Processing: _${command.text || "What can I help with?"}_`,
    });

    const envelope = normalizeSlashCommand(command, result.ts!);

    await handler(envelope, client);
  });

  return app;
}
