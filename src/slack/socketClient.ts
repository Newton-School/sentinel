import bolt from "@slack/bolt";
const { App } = bolt;
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { createMessageDeduper } from "./dedupe.js";
import type { SlackEventEnvelope } from "../types/contracts.js";

const log = createLogger("slack");

export type EventHandler = (
  envelope: SlackEventEnvelope,
  client: InstanceType<typeof App>["client"]
) => Promise<void>;

/** A normalized `reaction_added` on a message (the feedback signal). */
export interface ReactionEnvelope {
  reactorUserId: string;
  channelId: string;
  itemTs: string;
  reaction: string;
}

export type ReactionHandler = (env: ReactionEnvelope) => void | Promise<void>;

/**
 * Normalize a `reaction_added` event, or null when it isn't a reaction on a
 * message (only message reactions can be feedback on a bot reply).
 */
export function normalizeReactionAdded(event: {
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}): ReactionEnvelope | null {
  if (
    !event.user ||
    !event.reaction ||
    event.item?.type !== "message" ||
    !event.item.channel ||
    !event.item.ts
  ) {
    return null;
  }
  return {
    reactorUserId: event.user,
    channelId: event.item.channel,
    itemTs: event.item.ts,
    reaction: event.reaction,
  };
}

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

/** Stable per-event de-dupe key. Keyed on channel+ts to avoid cross-channel ts collisions. */
function dedupeKey(envelope: SlackEventEnvelope): string {
  return `${envelope.channelId}:${envelope.messageTs}`;
}

export function createSlackApp(handler: EventHandler, reactionHandler?: ReactionHandler) {
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
    logLevel: bolt.LogLevel.WARN,
  });

  // Slack re-delivers events when a handler is slow (Claude can take up to
  // 120s), so the same message can arrive multiple times. One deduper per app
  // instance suppresses repeat processing of the same channel+ts.
  const deduper = createMessageDeduper();

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

    if (!deduper.shouldProcess(dedupeKey(envelope))) {
      log.warn(
        { channelId: envelope.channelId, messageTs: envelope.messageTs },
        "Duplicate mention delivery, ignoring"
      );
      return;
    }

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

    if (!deduper.shouldProcess(dedupeKey(envelope))) {
      log.warn(
        { channelId: envelope.channelId, messageTs: envelope.messageTs },
        "Duplicate DM delivery, ignoring"
      );
      return;
    }

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

    if (!deduper.shouldProcess(dedupeKey(envelope))) {
      log.warn(
        { channelId: envelope.channelId, messageTs: envelope.messageTs },
        "Duplicate slash command delivery, ignoring"
      );
      return;
    }

    await handler(envelope, client);
  });

  // Handle 👍/👎 reactions on the bot's replies (feedback loop). Only wired
  // when a reaction handler is supplied (i.e. FEEDBACK_ENABLED), and requires
  // the `reaction_added` event subscription + `reactions:read` scope on the
  // Slack app.
  if (reactionHandler) {
    app.event("reaction_added", async ({ event }) => {
      const e = event as {
        user?: string;
        reaction?: string;
        item?: { type?: string; channel?: string; ts?: string };
      };
      // Ignore the bot's own reactions (e.g. :eyes:/:white_check_mark:).
      if (!e.user || e.user === config.BOT_USER_ID) return;
      if (!isAllowed(e.user)) {
        log.warn({ userId: e.user }, "Unauthorized user reaction, ignoring");
        return;
      }
      const env = normalizeReactionAdded(e);
      if (!env) return;
      await reactionHandler(env);
    });
  }

  return app;
}
