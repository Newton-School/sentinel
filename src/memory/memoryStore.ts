/**
 * Main-process wrappers around the memory SQL: binds the lazy `getDb()`
 * singleton so callers (the Slack event loop, the system-prompt builder)
 * never juggle handles. The db-handle-parameterized functions themselves
 * live in memorySql.ts so a separate-process MCP server can reuse them with
 * its own handle in a later PR.
 */

import { getDb } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import {
  recordMemoryFactStored,
  recordMemoryInjected,
  recordMemoryRetrievalEmpty,
} from "../metrics/registry.js";
import {
  insertFact as sqlInsertFact,
  forgetMemory as sqlForgetMemory,
  supersedeMemory as sqlSupersedeMemory,
  recentMemories as sqlRecentMemories,
  searchCandidates,
} from "./memorySql.js";
import { rankMemories, sanitizeFtsQuery } from "./rank.js";
import { isEntityGraphEnabled, linkFactEntities } from "./entityLink.js";
import { config } from "../config.js";
import { buildViewerScope, canView, type ViewerScope } from "../access/scope.js";
import type { MemoryCandidate } from "./types.js";
import type {
  InsertResult,
  MemoryRow,
  NewFact,
  RankedMemory,
} from "./types.js";

const log = createLogger("memory-store");

/**
 * Resolves the current asker into a ViewerScope using the configured founder
 * list (MEMORY_FOUNDER_USER_IDS, defaulting to ALLOWED_USER_IDS). Entity/team
 * context is left empty for now — in founders mode (the only active policy) a
 * founder sees everything regardless, so it isn't needed until scoped mode.
 */
export function currentViewerScope(userId: string): ViewerScope {
  const envFounders = (process.env.MEMORY_FOUNDER_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const founderUserIds = envFounders.length > 0 ? envFounders : config.ALLOWED_USER_IDS;
  return buildViewerScope(userId, { founderUserIds });
}

/**
 * Whether a candidate is visible to `viewer`. A legacy string viewer keeps the
 * original exact-visibility filter (byte-for-byte backward compatible); a
 * ViewerScope routes through the canView ACL predicate.
 */
function candidateVisible(c: MemoryCandidate, viewer: ViewerScope | string): boolean {
  if (typeof viewer === "string") return c.visibility === viewer;
  return canView(
    {
      visibility: c.visibility,
      subjectEntityId: c.subjectEntityId,
      scopeTeamId: c.scopeTeamId,
      sensitivity: c.sensitivity,
    },
    viewer
  );
}

/**
 * Retrieves the top-k organizational memories relevant to `query`, filtered
 * to what `viewer` may see via the canView ACL seam. A legacy string viewer
 * (the default) preserves the pre-brain exact-visibility filter.
 *
 * Synchronous (better-sqlite3) and failure-proof by contract: ANY internal
 * error is logged and swallowed, returning [] — a memory failure must never
 * fail a Slack reply.
 */
export function searchMemories(
  query: string,
  k = 6,
  viewer: ViewerScope | string = "founders"
): RankedMemory[] {
  // Metrics note: searchMemories is the only in-process recall path, and its
  // return value is exactly what buildSystemPrompt injects — so the
  // injected/retrieval-empty counters live here (index.ts's main() is
  // untestable wiring). Every zero-result exit, including the sanitized-empty
  // and error paths, counts as one empty retrieval.
  let results: RankedMemory[] = [];
  try {
    const db = getDb();
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      const candidates = searchCandidates(db, ftsQuery).filter((c) =>
        candidateVisible(c, viewer)
      );
      results = rankMemories(candidates, new Date(), k);
    }
  } catch (err) {
    log.warn({ err }, "Memory recall failed (non-fatal) — returning none");
    results = [];
  }

  if (results.length === 0) recordMemoryRetrievalEmpty();
  else recordMemoryInjected(results.length);
  return results;
}

// Thin getDb-bound wrappers (used by the extraction/ingestion PRs).

export function insertFact(fact: NewFact): InsertResult {
  const db = getDb();
  const result = sqlInsertFact(db, fact);
  // One "stored" event whether freshly inserted or dedup-reinforced. The
  // memory MCP server (separate process) inserts via memorySql directly and
  // does NOT report metrics — see src/metrics/registry.ts.
  recordMemoryFactStored(fact.sourceType);

  // Resolve & link the fact's entities into the company-brain graph. Gated on
  // a runtime kill switch (ships inert) and best-effort: a linking failure
  // must never fail a fact insert or, transitively, a Slack reply.
  if (isEntityGraphEnabled()) {
    try {
      linkFactEntities(db, result.id, fact);
    } catch (err) {
      log.warn({ err }, "Entity linking failed (non-fatal)");
    }
  }
  return result;
}

export function forgetMemory(id: number, now?: Date): boolean {
  return sqlForgetMemory(getDb(), id, now);
}

export function supersedeMemory(oldId: number, fact: NewFact): InsertResult {
  return sqlSupersedeMemory(getDb(), oldId, fact);
}

export function recentMemories(limit?: number): MemoryRow[] {
  return sqlRecentMemories(getDb(), limit);
}
