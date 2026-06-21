/**
 * All SQL for the organizational memory store.
 *
 * Every function takes a `Queryable` (the pg Pool, a transaction client, or the
 * per-request memory MCP server's own pool) as its FIRST argument and never
 * calls `getPool()` itself: the separate-process MCP server binds its own pool
 * to the same database. Keep this module free of main-process singletons.
 *
 * Lexical search is opportunistic and layered: ParadeDB `pg_search` BM25 when
 * available, else portable Postgres `ts_rank` over the generated `fts` column,
 * else a LIKE OR-scan. Any failure degrades to the next tier — it must never
 * throw out of this module's search/insert paths for full-text reasons alone.
 */

import { createHash } from "node:crypto";
import { isFtsAvailable, withTxOn, type DbPool, type Queryable } from "../state/db.js";
import { sanitizeFtsQuery } from "./rank.js";
import { jaccard, normalizeForHash, stripProvenanceSuffix, tokenSet } from "./textMatch.js";
import { toVectorLiteral } from "./embedder.js";
import type {
  InsertResult,
  MemoryCandidate,
  MemoryRow,
  NewFact,
} from "./types.js";

// Re-exported for backward compatibility: callers that imported
// `normalizeForHash` from this module keep working.
export { normalizeForHash } from "./textMatch.js";

/** Hard cap on stored fact text length. */
export const MAX_FACT_TEXT_CHARS = 300;

/** Token-set Jaccard threshold above which a new fact reinforces an existing one. */
export const NEAR_DUP_JACCARD = 0.85;

// Raw row shape as returned by Postgres (snake_case columns).
interface MemoryDbRow {
  id: number;
  text: string;
  category: MemoryRow["category"];
  entities: string | null;
  source_type: MemoryRow["sourceType"];
  source_ref: string | null;
  source_label: string | null;
  speaker: string | null;
  asserted_at: string | null;
  evidence_quote: string | null;
  confidence: number;
  verified: number;
  visibility: string;
  sensitivity: MemoryRow["sensitivity"];
  derived_from_memory: number;
  content_hash: string;
  status: MemoryRow["status"];
  superseded_by: number | null;
  subject_entity_id: number | null;
  scope_team_id: number | null;
  created_at: string;
  updated_at: string;
}

function mapMemoryRow(row: MemoryDbRow): MemoryRow {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    entities: row.entities,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    sourceLabel: row.source_label,
    speaker: row.speaker,
    assertedAt: row.asserted_at,
    evidenceQuote: row.evidence_quote,
    confidence: row.confidence,
    verified: row.verified !== 0,
    visibility: row.visibility,
    sensitivity: row.sensitivity,
    derivedFromMemory: row.derived_from_memory !== 0,
    contentHash: row.content_hash,
    status: row.status,
    supersededBy: row.superseded_by,
    subjectEntityId: row.subject_entity_id ?? null,
    scopeTeamId: row.scope_team_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function contentHash(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

/** All selectable memory columns (excludes the internal `fts`/`embedding`). */
const MEMORY_COLS = `id, text, category, entities, source_type, source_ref, source_label,
  speaker, asserted_at, evidence_quote, confidence, verified, visibility, sensitivity,
  derived_from_memory, content_hash, status, superseded_by, subject_entity_id, scope_team_id,
  created_at, updated_at`;

/**
 * Extracts the bare significant tokens from a sanitized FTS query string (the
 * `"a" OR "b"` form produced by sanitizeFtsQuery). Used to build a Postgres
 * tsquery / pg_search match string / LIKE pattern list.
 */
function extractTokens(ftsQuery: string): string[] {
  const quoted = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  return ftsQuery.split(/\s+/).filter((t) => t && !/^(AND|OR|NOT)$/i.test(t));
}

/**
 * Inserts a fact, deduping aggressively:
 *  1. Near-dup gate: full-text match the fact's significant tokens, take the top
 *     active candidates and compute a token-set Jaccard in code. At >= 0.85 the
 *     existing row is reinforced (confidence = max of both, updated_at
 *     refreshed) instead of inserting a new one.
 *  2. Exact-dup gate: a UNIQUE content hash over the normalized text, with
 *     `ON CONFLICT DO UPDATE` keeping the max confidence. This also covers the
 *     full-text-unavailable case and lost races.
 *
 * Text is hard-capped at 300 chars (truncated). Empty text is rejected.
 */
export async function insertFact(q: Queryable, fact: NewFact): Promise<InsertResult> {
  const rawText = fact.text.length > MAX_FACT_TEXT_CHARS
    ? fact.text.slice(0, MAX_FACT_TEXT_CHARS)
    : fact.text;
  if (normalizeForHash(rawText).length === 0) {
    throw new Error("insertFact: fact text must not be empty");
  }
  // Dedup identity ignores a trailing provenance parenthetical (the stored text
  // keeps it): the same statement stored manually with attribution and
  // re-extracted bare by the conversation hook must collapse to one row.
  const normalized = normalizeForHash(stripProvenanceSuffix(rawText));

  const now = (fact.now ?? new Date()).toISOString();
  const hash = contentHash(normalized);
  const confidence = fact.confidence ?? 0.7;

  // --- Near-dup gate (best-effort full-text) -----------------------------
  const tokens = extractTokens(sanitizeFtsQuery(rawText));
  if (tokens.length > 0) {
    try {
      const candidates = await ftsCandidateIds(q, tokens, 3);
      const newTokens = tokenSet(normalized);
      for (const candidate of candidates) {
        const similarity = jaccard(
          newTokens,
          tokenSet(normalizeForHash(stripProvenanceSuffix(candidate.text)))
        );
        if (similarity >= NEAR_DUP_JACCARD) {
          await q.query(
            `UPDATE memories SET confidence = GREATEST(confidence, $1), updated_at = $2 WHERE id = $3`,
            [confidence, now, candidate.id]
          );
          return { deduped: true, id: candidate.id };
        }
      }
    } catch {
      // Full-text unavailable: fall through to the hash-based upsert, which
      // still dedups exact re-assertions.
    }
  }

  // --- Hash upsert --------------------------------------------------------
  // Pre-check only informs the `deduped` flag; the ON CONFLICT clause is what
  // makes the write race-safe (joinStore/persona-store pattern).
  const existing = (await q.query(`SELECT id FROM memories WHERE content_hash = $1`, [hash]))
    .rows[0] as { id: number } | undefined;

  const row = (await q.query(
    `INSERT INTO memories (
       text, category, entities, source_type, source_ref, source_label,
       speaker, asserted_at, evidence_quote, confidence, sensitivity,
       content_hash, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (content_hash) DO UPDATE SET
       confidence = GREATEST(memories.confidence, EXCLUDED.confidence),
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      rawText,
      fact.category,
      fact.entities ? JSON.stringify(fact.entities) : null,
      fact.sourceType,
      fact.sourceRef ?? null,
      fact.sourceLabel ?? null,
      fact.speaker ?? null,
      fact.assertedAt ?? null,
      fact.evidenceQuote ?? null,
      confidence,
      fact.sensitivity ?? "normal",
      hash,
      now,
      now,
    ]
  )).rows[0] as { id: number };

  return { deduped: existing !== undefined, id: row.id };
}

/**
 * Top active memory ids matching `tokens`, best-match first. Tries pg_search
 * BM25 (ParadeDB) then portable `ts_rank`; the caller's try/catch guards
 * full-text failures.
 */
async function ftsCandidateIds(
  q: Queryable,
  tokens: string[],
  limit: number
): Promise<Array<{ id: number; text: string }>> {
  if (isFtsAvailable()) {
    try {
      return (await q.query(
        `SELECT id, text FROM memories
         WHERE id @@@ $1 AND status = 'active'
         ORDER BY paradedb.score(id) DESC
         LIMIT $2`,
        [tokens.join(" "), limit]
      )).rows as Array<{ id: number; text: string }>;
    } catch {
      // pg_search query shape mismatch — fall back to ts_rank.
    }
  }
  const tsquery = tokens.join(" | ");
  return (await q.query(
    `SELECT id, text FROM memories
     WHERE status = 'active' AND fts @@ to_tsquery('english', $1)
     ORDER BY ts_rank(fts, to_tsquery('english', $1)) DESC
     LIMIT $2`,
    [tsquery, limit]
  )).rows as Array<{ id: number; text: string }>;
}

/**
 * Full-text candidate search over active memories. Tiered: pg_search BM25
 * (ParadeDB) → portable Postgres `ts_rank` over the generated `fts` column →
 * a LIKE OR-scan ranked by recency. The emitted `bm` follows the convention
 * used by rank.ts (`-bm` = "higher is better"): BM25/ts_rank scores are stored
 * negated, the LIKE fallback uses a constant.
 */
export async function searchCandidates(
  q: Queryable,
  ftsQuery: string,
  limit = 30
): Promise<MemoryCandidate[]> {
  if (!ftsQuery.trim()) return [];
  const tokens = extractTokens(ftsQuery);
  if (tokens.length === 0) return [];

  // 1. pg_search BM25 (ParadeDB only)
  if (isFtsAvailable()) {
    try {
      const rows = (await q.query(
        `SELECT ${MEMORY_COLS}, -paradedb.score(id) AS bm
         FROM memories
         WHERE id @@@ $1 AND status = 'active'
         ORDER BY paradedb.score(id) DESC
         LIMIT $2`,
        [tokens.join(" "), limit]
      )).rows as Array<MemoryDbRow & { bm: number }>;
      return rows.map((r) => ({ ...mapMemoryRow(r), bm: r.bm }));
    } catch {
      // fall through to ts_rank
    }
  }

  // 2. Portable Postgres full-text (works on any PG incl. ParadeDB)
  try {
    const tsquery = tokens.join(" | ");
    const rows = (await q.query(
      `SELECT ${MEMORY_COLS}, -ts_rank(fts, to_tsquery('english', $1)) AS bm
       FROM memories
       WHERE status = 'active' AND fts @@ to_tsquery('english', $1)
       ORDER BY ts_rank(fts, to_tsquery('english', $1)) DESC
       LIMIT $2`,
      [tsquery, limit]
    )).rows as Array<MemoryDbRow & { bm: number }>;
    if (rows.length > 0) return rows.map((r) => ({ ...mapMemoryRow(r), bm: r.bm }));
  } catch {
    // fall through to LIKE scan
  }

  // 3. LIKE OR-scan (last resort; constant bm → ranker uses recency/confidence)
  const conditions = tokens
    .map(
      (_t, i) =>
        `(m.text ILIKE $${i * 3 + 1} OR m.entities ILIKE $${i * 3 + 2} OR m.source_label ILIKE $${i * 3 + 3})`
    )
    .join(" OR ");
  const params: unknown[] = tokens.flatMap((t) => {
    const pattern = `%${t}%`;
    return [pattern, pattern, pattern];
  });
  params.push(limit);
  const rows = (await q.query(
    `SELECT ${MEMORY_COLS}, -1.0 AS bm
     FROM memories m
     WHERE m.status = 'active' AND (${conditions})
     ORDER BY m.updated_at DESC, m.id DESC
     LIMIT $${tokens.length * 3 + 1}`,
    params
  )).rows as Array<MemoryDbRow & { bm: number }>;
  return rows.map((r) => ({ ...mapMemoryRow(r), bm: r.bm }));
}

/** Marks a memory forgotten (soft delete). Returns true when a row changed. */
export async function forgetMemory(
  q: Queryable,
  id: number,
  now: Date = new Date()
): Promise<boolean> {
  const r = await q.query(
    `UPDATE memories SET status = 'forgotten', updated_at = $1 WHERE id = $2`,
    [now.toISOString(), id]
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Replaces a memory: inserts `fact` and marks the old row superseded, pointing
 * at the replacement. Refuses (throws) when the new fact's `assertedAt` is older
 * than the old row's — a stale assertion must never silently retire a newer
 * one. Atomic (single transaction on the supplied pool).
 */
export async function supersedeMemory(
  pool: DbPool,
  oldId: number,
  fact: NewFact
): Promise<InsertResult> {
  const now = (fact.now ?? new Date()).toISOString();
  return withTxOn(pool, async (client): Promise<InsertResult> => {
    const old = (await client.query(
      `SELECT id, asserted_at FROM memories WHERE id = $1`,
      [oldId]
    )).rows[0] as { id: number; asserted_at: string | null } | undefined;
    if (!old) {
      throw new Error(`supersedeMemory: memory ${oldId} not found`);
    }
    if (fact.assertedAt && old.asserted_at && fact.assertedAt < old.asserted_at) {
      throw new Error(
        `supersedeMemory: refusing to supersede memory ${oldId} with an older assertion ` +
          `(${fact.assertedAt} < ${old.asserted_at})`
      );
    }

    const result = await insertFact(client, fact);
    // If the "new" fact deduped onto the old row itself there is nothing to
    // supersede — never let a row supersede itself.
    if (result.id !== oldId) {
      await client.query(
        `UPDATE memories SET status = 'superseded', superseded_by = $1, updated_at = $2 WHERE id = $3`,
        [result.id, now, oldId]
      );
    }
    return result;
  });
}

/**
 * Sets a row's embedding, but only when it's currently NULL — idempotent and
 * dedup-safe (a deduped row keeps its existing vector).
 */
export async function setEmbedding(q: Queryable, id: number, embedding: Float32Array): Promise<void> {
  await q.query(
    `UPDATE memories SET embedding = $1::vector WHERE id = $2 AND embedding IS NULL`,
    [toVectorLiteral(embedding), id]
  );
}

/**
 * Active rows still needing an embedding, newest first. Excludes
 * `sensitivity='sensitive'` rows — those are NEVER sent to the external
 * embedding API (privacy), so they must not be returned here.
 */
export async function memoriesMissingEmbedding(
  q: Queryable,
  limit = 200
): Promise<Array<{ id: number; text: string }>> {
  return (await q.query(
    `SELECT id, text FROM memories
     WHERE status = 'active' AND embedding IS NULL AND sensitivity != 'sensitive'
     ORDER BY updated_at DESC, id DESC
     LIMIT $1`,
    [limit]
  )).rows as Array<{ id: number; text: string }>;
}

/**
 * Semantic (vector) candidates: scores active, embedded rows by cosine to
 * `queryVec` using pgvector's `<=>` operator (`cos = 1 - distance`), returning
 * the top `topK`. `bm` is neutral (0) so fusion treats these as lexically
 * unranked unless they also matched full-text.
 */
export async function semanticCandidates(
  q: Queryable,
  queryVec: Float32Array,
  poolLimit = 2000,
  topK = 30
): Promise<MemoryCandidate[]> {
  const vec = toVectorLiteral(queryVec);
  const rows = (await q.query(
    `SELECT ${MEMORY_COLS}, 1 - (embedding <=> $1::vector) AS cos
     FROM memories
     WHERE status = 'active' AND embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [vec, Math.min(poolLimit, topK)]
  )).rows as Array<MemoryDbRow & { cos: number }>;
  return rows.map((r) => ({ ...mapMemoryRow(r), bm: 0, cos: r.cos }));
}

/** Loads active memory rows by id (entity-linked-fact retrieval). */
export async function getMemoriesByIds(q: Queryable, ids: number[]): Promise<MemoryRow[]> {
  if (ids.length === 0) return [];
  const rows = (await q.query(
    `SELECT ${MEMORY_COLS} FROM memories WHERE status = 'active' AND id = ANY($1)`,
    [ids]
  )).rows as MemoryDbRow[];
  return rows.map(mapMemoryRow);
}

/** Active memories created on/after `sinceIso`, newest first (for digests). */
export async function recentFactsSince(
  q: Queryable,
  sinceIso: string,
  limit = 50
): Promise<MemoryRow[]> {
  const rows = (await q.query(
    `SELECT ${MEMORY_COLS} FROM memories
     WHERE status = 'active' AND created_at >= $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [sinceIso, limit]
  )).rows as MemoryDbRow[];
  return rows.map(mapMemoryRow);
}

/** Most recently created active memories, newest first. */
export async function recentMemories(q: Queryable, limit = 20): Promise<MemoryRow[]> {
  const rows = (await q.query(
    `SELECT ${MEMORY_COLS} FROM memories WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  )).rows as MemoryDbRow[];
  return rows.map(mapMemoryRow);
}

/** Reads an ingestion cursor (e.g. a Gmail historyId). Null when unset. */
export async function getCursor(q: Queryable, source: string): Promise<string | null> {
  const row = (await q.query(`SELECT cursor FROM ingest_cursors WHERE source = $1`, [source]))
    .rows[0] as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

/** Upserts an ingestion cursor (race-safe ON CONFLICT, joinStore pattern). */
export async function setCursor(
  q: Queryable,
  source: string,
  cursor: string,
  now: Date = new Date()
): Promise<void> {
  await q.query(
    `INSERT INTO ingest_cursors (source, cursor, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (source) DO UPDATE SET
       cursor = EXCLUDED.cursor,
       updated_at = EXCLUDED.updated_at`,
    [source, cursor, now.toISOString()]
  );
}

/** Records a document as ingested. Duplicate marks update the timestamp. */
export async function markIngested(
  q: Queryable,
  docId: string,
  nowMs: number = Date.now()
): Promise<void> {
  await q.query(
    `INSERT INTO ingested_docs (doc_id, ingested_at)
     VALUES ($1, $2)
     ON CONFLICT (doc_id) DO UPDATE SET ingested_at = EXCLUDED.ingested_at`,
    [docId, nowMs]
  );
}

/** True when the document has already been ingested. */
export async function isIngested(q: Queryable, docId: string): Promise<boolean> {
  const row = (await q.query(`SELECT 1 AS hit FROM ingested_docs WHERE doc_id = $1`, [docId]))
    .rows[0];
  return row !== undefined;
}

/** Deletes ingest-dedup rows strictly older than `cutoffMs` (TTL purge). */
export async function purgeIngested(q: Queryable, cutoffMs: number): Promise<number> {
  const r = await q.query(`DELETE FROM ingested_docs WHERE ingested_at < $1`, [cutoffMs]);
  return r.rowCount ?? 0;
}
