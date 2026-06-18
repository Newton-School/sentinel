/**
 * Slack user-group access gate. Sentinel access is granted to members of the
 * `@sentinel-access-group` user group (plus the owner — handled in
 * socketClient's isAllowed). Membership is resolved from Slack into an in-memory
 * cache and refreshed periodically (a poll loop, like ingestWatcher), so the
 * synchronous gate never makes an API call per message.
 *
 * Fail-safe: on any resolution failure (missing `usergroups:read` scope, API
 * error, handle not found) the cache is left AS-IS (stale ≥ empty) and a warning
 * is logged — combined with the always-allowed owner, a hiccup can never lock
 * everyone out.
 *
 * Requires the bot token to have the `usergroups:read` OAuth scope.
 */

import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("access-group");

/** Default refresh cadence (matches the memory ingest watcher). */
export const ACCESS_GROUP_REFRESH_MS = 5 * 60 * 1000;

// Module-scoped membership cache (the synchronous gate reads this).
let members = new Set<string>();
let fetchedAt = 0;

/** Minimal shape of the Slack client we use (structurally satisfied by WebClient). */
interface UsergroupsClient {
  usergroups: {
    list: (opts: {
      include_users?: boolean;
      include_disabled?: boolean;
    }) => Promise<{
      ok?: boolean;
      usergroups?: Array<{ handle?: string; name?: string; users?: string[] }>;
    }>;
  };
}

/** True when `userId` is currently a cached member of the access group. */
export function isAccessGroupMember(userId: string): boolean {
  return members.has(userId);
}

/** The current cached membership (read-only); for inspection/tests. */
export function getAccessGroupMembers(): ReadonlySet<string> {
  return members;
}

/** Test hook: set the cached membership directly. */
export function __setAccessMembersForTests(ids: string[]): void {
  members = new Set(ids);
  fetchedAt = 0;
}

/**
 * The denial message for a non-member. `ownerUserId` (config.SENTINEL_OWNER_USER_ID)
 * is rendered as a real Slack mention so the requester can ping the owner.
 */
export function denialMessage(ownerUserId?: string): string {
  const who = ownerUserId ? `<@${ownerUserId}>` : "@theOG";
  return `you dont have access to me, connect ${who} for this`;
}

/**
 * Resolve the configured group handle to its members and refresh the cache.
 * Never throws. On failure the prior cache is preserved.
 */
export async function refreshAccessGroupMembers(
  web: UsergroupsClient
): Promise<{ ok: boolean; count: number }> {
  const handle = config.SENTINEL_ACCESS_GROUP_HANDLE;
  try {
    const res = await web.usergroups.list({ include_users: true, include_disabled: false });
    const groups = res.usergroups ?? [];
    const group = groups.find((g) => g.handle === handle);
    if (!group) {
      log.warn(
        { handle, available: groups.map((g) => g.handle) },
        "Access group handle not found — keeping previous membership cache"
      );
      return { ok: false, count: members.size };
    }
    members = new Set(group.users ?? []);
    fetchedAt = Date.now();
    log.info({ handle, count: members.size }, "Access-group membership refreshed");
    return { ok: true, count: members.size };
  } catch (err) {
    // Most likely a missing `usergroups:read` scope, or a transient API error.
    log.warn(
      { err, handle },
      "Failed to refresh access-group membership (need usergroups:read?) — keeping previous cache"
    );
    return { ok: false, count: members.size };
  }
}

/**
 * Start the access-group poll loop. Does an immediate, AWAITED refresh so the
 * cache is warm before Slack starts accepting events, then refreshes on the
 * interval (overlap-guarded). Returns a `stop()` that clears the interval.
 *
 * `web` is injectable for tests; in production it defaults to a bot-token client.
 */
export async function startAccessGroupWatcher(
  intervalMs: number = ACCESS_GROUP_REFRESH_MS,
  web: UsergroupsClient = new WebClient(config.SLACK_BOT_TOKEN)
): Promise<() => void> {
  let running = false;
  async function runOnce(): Promise<void> {
    if (running) {
      log.warn("Previous access-group refresh still running — skipping this tick");
      return;
    }
    running = true;
    try {
      await refreshAccessGroupMembers(web);
    } finally {
      running = false;
    }
  }

  log.info(
    { intervalMs, handle: config.SENTINEL_ACCESS_GROUP_HANDLE },
    "Starting access-group watcher"
  );
  await runOnce(); // warm the cache before the gate goes live
  const intervalId = setInterval(() => void runOnce(), intervalMs);

  return function stop(): void {
    clearInterval(intervalId);
    log.info("Access-group watcher stopped");
  };
}
