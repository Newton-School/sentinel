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
import type {
  InsertResult,
  MemoryRow,
  NewFact,
  RankedMemory,
} from "./types.js";

const log = createLogger("memory-store");

/**
 * Retrieves the top-k organizational memories relevant to `query`, filtered
 * to what `viewer` may see (v1: only `visibility = 'founders'` rows exist).
 *
 * Synchronous (better-sqlite3) and failure-proof by contract: ANY internal
 * error is logged and swallowed, returning [] — a memory failure must never
 * fail a Slack reply.
 */
export function searchMemories(
  query: string,
  k = 6,
  viewer = "founders"
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
      const candidates = searchCandidates(db, ftsQuery).filter(
        (c) => c.visibility === viewer
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
  const result = sqlInsertFact(getDb(), fact);
  // One "stored" event whether freshly inserted or dedup-reinforced. The
  // memory MCP server (separate process) inserts via memorySql directly and
  // does NOT report metrics — see src/metrics/registry.ts.
  recordMemoryFactStored(fact.sourceType);
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
