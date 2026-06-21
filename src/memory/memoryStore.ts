/**
 * Main-process wrappers around the memory SQL: binds the shared `getPool()`
 * pool so callers (the Slack event loop, the system-prompt builder)
 * never juggle handles. The Queryable-parameterized functions themselves
 * live in memorySql.ts so a separate-process MCP server can reuse them with
 * its own pool in a later PR.
 */

import { getPool } from "../state/db.js";
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
  getMemoriesByIds,
  semanticCandidates,
} from "./memorySql.js";
import {
  getEntityMemoryIds,
  getEntityProfile,
  resolveQueryEntities,
  type MentionedEntity,
} from "./entitySql.js";
import type { EntityDossierRef } from "./types.js";
import { fuseCandidates, rankHybrid, rankMemories, sanitizeFtsQuery } from "./rank.js";
import { isEntityGraphEnabled, linkFactEntities } from "./entityLink.js";
import { config } from "../config.js";
import { buildViewerScope, canView, type ViewerScope } from "../access/scope.js";
import type { MemoryCandidate } from "./types.js";
import type {
  InsertResult,
  MemoryRow,
  NewFact,
  RankedMemory,
  RetrievalBundle,
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
function candidateVisible(c: MemoryRow, viewer: ViewerScope | string): boolean {
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
 * Sensitive facts (HR/comp/legal/medical) are excluded from AMBIENT recall —
 * the system-prompt injection that happens on every query — unless
 * MEMORY_SENSITIVE_RECALL=on. Founders can still retrieve them deliberately via
 * the memory_search MCP tool's include_sensitive flag (audited, separate path).
 */
function ambientAllowsSensitive(): boolean {
  return process.env.MEMORY_SENSITIVE_RECALL === "on";
}

/** Combined recall filter: ACL scope AND the ambient sensitivity gate. */
function recallVisible(c: MemoryRow, viewer: ViewerScope | string): boolean {
  if (!ambientAllowsSensitive() && c.sensitivity === "sensitive") return false;
  return candidateVisible(c, viewer);
}

/**
 * Retrieves the top-k organizational memories relevant to `query`, filtered
 * to what `viewer` may see via the canView ACL seam. A legacy string viewer
 * (the default) preserves the pre-brain exact-visibility filter.
 *
 * Async (node-postgres) and failure-proof by contract: ANY internal error is
 * logged and swallowed, returning [] — a memory failure must never fail a
 * Slack reply.
 */
export async function searchMemories(
  query: string,
  k = 6,
  viewer: ViewerScope | string = "founders"
): Promise<RankedMemory[]> {
  // Metrics note: searchMemories is the only in-process recall path, and its
  // return value is exactly what buildSystemPrompt injects — so the
  // injected/retrieval-empty counters live here (index.ts's main() is
  // untestable wiring). Every zero-result exit, including the sanitized-empty
  // and error paths, counts as one empty retrieval.
  let results: RankedMemory[] = [];
  try {
    const pool = getPool();
    const ftsQuery = sanitizeFtsQuery(query);
    if (ftsQuery) {
      const candidates = (await searchCandidates(pool, ftsQuery)).filter((c) =>
        recallVisible(c, viewer)
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

/**
 * Entity-aware retrieval: assembles a {@link RetrievalBundle} from two sources —
 * (1) the keyword/text search (today's recall), and (2) facts linked to
 * entities named in the query, deduped against the text-search results. Both
 * are scope-filtered via the canView seam.
 *
 * Failure-proof like searchMemories: any internal error returns a well-formed
 * empty bundle — a memory failure must never fail a Slack reply. Each entity
 * fact is ranked with a constant relevance term (bm = -1, the LIKE-fallback
 * convention) so recency/category/confidence order them.
 */
export async function assembleRetrieval(
  query: string,
  _askerUserId: string,
  viewer: ViewerScope | string = "founders",
  queryVec?: Float32Array
): Promise<RetrievalBundle> {
  let queryFacts: RankedMemory[] = [];
  let entityFacts: RankedMemory[] = [];
  let mentionedEntities: MentionedEntity[] = [];
  const dossiers: EntityDossierRef[] = [];
  try {
    const pool = getPool();
    const now = new Date();

    // Query-text facts: hybrid (BM25 ⊕ cosine) when a query embedding is
    // supplied, else BM25-only. Both scope-filtered via canView.
    const ftsQuery = sanitizeFtsQuery(query);
    const ftsCandidates = ftsQuery
      ? (await searchCandidates(pool, ftsQuery)).filter((c) => recallVisible(c, viewer))
      : [];
    if (queryVec) {
      const semantic = (await semanticCandidates(pool, queryVec)).filter((c) =>
        recallVisible(c, viewer)
      );
      queryFacts = rankHybrid(fuseCandidates(ftsCandidates, semantic), now, 6);
    } else {
      queryFacts = rankMemories(ftsCandidates, now, 6);
    }

    mentionedEntities = await resolveQueryEntities(pool, query, 3);
    const seen = new Set<number>(queryFacts.map((f) => f.id));
    const entityCandidates: MemoryCandidate[] = [];
    for (const m of mentionedEntities) {
      // A consolidated dossier replaces this entity's raw facts (store a lot,
      // inject a little) — only fall back to raw linked facts when none exists.
      const profile = await getEntityProfile(pool, m.entityId);
      if (profile && profile.profileMd.trim().length > 0) {
        dossiers.push({
          entityId: m.entityId,
          name: m.name,
          type: m.type,
          profileMd: profile.profileMd,
          version: profile.version,
          builtAt: profile.builtAt,
        });
        continue;
      }
      const ids = await getEntityMemoryIds(pool, m.entityId);
      for (const row of await getMemoriesByIds(pool, ids)) {
        if (seen.has(row.id) || !recallVisible(row, viewer)) continue;
        seen.add(row.id);
        entityCandidates.push({ ...row, bm: -1 });
      }
    }
    entityFacts = rankMemories(entityCandidates, now, 8);
  } catch (err) {
    log.warn({ err }, "Entity-aware retrieval failed (non-fatal) — empty bundle");
    return { queryFacts: [], entityFacts: [], mentionedEntities: [], dossiers: [] };
  }

  const total = queryFacts.length + entityFacts.length + dossiers.length;
  if (total === 0) recordMemoryRetrievalEmpty();
  else recordMemoryInjected(total);

  return {
    queryFacts,
    entityFacts,
    dossiers,
    mentionedEntities: mentionedEntities.map((m) => ({
      entityId: m.entityId,
      name: m.name,
      type: m.type,
    })),
  };
}

// Thin pool-bound wrappers (used by the extraction/ingestion PRs).

export async function insertFact(fact: NewFact): Promise<InsertResult> {
  const pool = getPool();
  const result = await sqlInsertFact(pool, fact);
  // One "stored" event whether freshly inserted or dedup-reinforced. The
  // memory MCP server (separate process) inserts via memorySql directly and
  // does NOT report metrics — see src/metrics/registry.ts.
  recordMemoryFactStored(fact.sourceType);

  // Resolve & link the fact's entities into the company-brain graph. Gated on
  // a runtime kill switch (ships inert) and best-effort: a linking failure
  // must never fail a fact insert or, transitively, a Slack reply.
  if (isEntityGraphEnabled()) {
    try {
      await linkFactEntities(pool, result.id, fact);
    } catch (err) {
      log.warn({ err }, "Entity linking failed (non-fatal)");
    }
  }
  return result;
}

export async function forgetMemory(id: number, now?: Date): Promise<boolean> {
  return sqlForgetMemory(getPool(), id, now);
}

export async function supersedeMemory(oldId: number, fact: NewFact): Promise<InsertResult> {
  return sqlSupersedeMemory(getPool(), oldId, fact);
}

export async function recentMemories(limit?: number): Promise<MemoryRow[]> {
  return sqlRecentMemories(getPool(), limit);
}
