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
  try {
    const db = getDb();
    const ftsQuery = sanitizeFtsQuery(query);
    if (!ftsQuery) return [];

    const candidates = searchCandidates(db, ftsQuery).filter(
      (c) => c.visibility === viewer
    );
    return rankMemories(candidates, new Date(), k);
  } catch (err) {
    log.warn({ err }, "Memory recall failed (non-fatal) — returning none");
    return [];
  }
}

// Thin getDb-bound wrappers (used by the extraction/ingestion PRs).

export function insertFact(fact: NewFact): InsertResult {
  return sqlInsertFact(getDb(), fact);
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
