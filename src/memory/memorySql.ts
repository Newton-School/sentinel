/**
 * All SQL for the organizational memory store.
 *
 * Every function takes a better-sqlite3 `db` handle as its FIRST argument and
 * never calls `getDb()` itself: a later PR runs a separate-process MCP server
 * that binds its own handle to the same database file. Keep this module free
 * of main-process singletons.
 *
 * FTS5 is used opportunistically: any MATCH failure (missing fts5 module,
 * dropped table) degrades to hash-only dedup on writes and a LIKE scan on
 * reads — it must never throw out of this module's search/insert paths for
 * FTS reasons alone.
 */

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { sanitizeFtsQuery } from "./rank.js";
import { jaccard, normalizeForHash, tokenSet } from "./textMatch.js";
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

// Raw row shape as returned by SQLite (snake_case columns).
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

/**
 * Inserts a fact, deduping aggressively:
 *  1. Near-dup gate: FTS-match the fact's significant tokens, take the top 3
 *     active candidates and compute a token-set Jaccard in code. At >= 0.85
 *     the existing row is reinforced (confidence = max of both, updated_at
 *     refreshed) instead of inserting a new one.
 *  2. Exact-dup gate: a UNIQUE content hash over the normalized text, with
 *     `ON CONFLICT DO UPDATE` keeping the max confidence. This also covers
 *     the FTS-unavailable case and lost races.
 *
 * Text is hard-capped at 300 chars (truncated). Empty text is rejected.
 */
export function insertFact(db: Database.Database, fact: NewFact): InsertResult {
  const rawText = fact.text.length > MAX_FACT_TEXT_CHARS
    ? fact.text.slice(0, MAX_FACT_TEXT_CHARS)
    : fact.text;
  const normalized = normalizeForHash(rawText);
  if (normalized.length === 0) {
    throw new Error("insertFact: fact text must not be empty");
  }

  const now = (fact.now ?? new Date()).toISOString();
  const hash = contentHash(normalized);
  const confidence = fact.confidence ?? 0.7;

  // --- Near-dup gate (best-effort; requires FTS) -------------------------
  const ftsQuery = sanitizeFtsQuery(rawText);
  if (ftsQuery) {
    try {
      const candidates = db
        .prepare(
          `SELECT m.id, m.text
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.rowid
           WHERE memories_fts MATCH ? AND m.status = 'active'
           ORDER BY bm25(memories_fts)
           LIMIT 3`
        )
        .all(ftsQuery) as Array<{ id: number; text: string }>;

      const newTokens = tokenSet(normalized);
      for (const candidate of candidates) {
        const similarity = jaccard(newTokens, tokenSet(normalizeForHash(candidate.text)));
        if (similarity >= NEAR_DUP_JACCARD) {
          db.prepare(
            `UPDATE memories SET confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?`
          ).run(confidence, now, candidate.id);
          return { deduped: true, id: candidate.id };
        }
      }
    } catch {
      // FTS unavailable (missing module / dropped table): fall through to the
      // hash-based upsert, which still dedups exact re-assertions.
    }
  }

  // --- Hash upsert --------------------------------------------------------
  // Pre-check only informs the `deduped` flag; the ON CONFLICT clause is what
  // makes the write race-safe (joinStore/persona-store pattern).
  const existing = db
    .prepare(`SELECT id FROM memories WHERE content_hash = ?`)
    .get(hash) as { id: number } | undefined;

  const row = db
    .prepare(
      `INSERT INTO memories (
         text, category, entities, source_type, source_ref, source_label,
         speaker, asserted_at, evidence_quote, confidence, sensitivity,
         content_hash, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(content_hash) DO UPDATE SET
         confidence = MAX(confidence, excluded.confidence),
         updated_at = excluded.updated_at
       RETURNING id`
    )
    .get(
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
      now
    ) as { id: number };

  return { deduped: existing !== undefined, id: row.id };
}

/**
 * Full-text candidate search over active memories, ranked by bm25 (text
 * weighted 2x over entities/source_label). Falls back to a LIKE OR-scan over
 * the same columns, ranked by recency with a constant `bm`, whenever FTS is
 * unavailable or MATCH throws.
 */
export function searchCandidates(
  db: Database.Database,
  ftsQuery: string,
  limit = 30
): MemoryCandidate[] {
  if (!ftsQuery.trim()) return [];

  try {
    const rows = db
      .prepare(
        `SELECT m.*, bm25(memories_fts, 2.0, 1.0, 1.0) AS bm
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active'
         ORDER BY bm
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<MemoryDbRow & { bm: number }>;
    return rows.map((r) => ({ ...mapMemoryRow(r), bm: r.bm }));
  } catch {
    // FTS unavailable or MATCH failed — degrade to a LIKE scan below.
  }

  // Extract bare tokens from the (normally quoted) FTS query.
  const quoted = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const tokens =
    quoted.length > 0
      ? quoted
      : ftsQuery.split(/\s+/).filter((t) => t && !/^(AND|OR|NOT)$/i.test(t));
  if (tokens.length === 0) return [];

  const conditions = tokens
    .map(() => `(m.text LIKE ? OR m.entities LIKE ? OR m.source_label LIKE ?)`)
    .join(" OR ");
  const params = tokens.flatMap((t) => {
    const pattern = `%${t}%`;
    return [pattern, pattern, pattern];
  });

  const rows = db
    .prepare(
      `SELECT m.*, -1.0 AS bm
       FROM memories m
       WHERE m.status = 'active' AND (${conditions})
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(...params, limit) as Array<MemoryDbRow & { bm: number }>;
  return rows.map((r) => ({ ...mapMemoryRow(r), bm: r.bm }));
}

/** Marks a memory forgotten (soft delete). Returns true when a row changed. */
export function forgetMemory(
  db: Database.Database,
  id: number,
  now: Date = new Date()
): boolean {
  const info = db
    .prepare(`UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?`)
    .run(now.toISOString(), id);
  return info.changes > 0;
}

/**
 * Replaces a memory: inserts `fact` and marks the old row superseded,
 * pointing at the replacement. Refuses (throws) when the new fact's
 * `assertedAt` is older than the old row's — a stale assertion must never
 * silently retire a newer one. Atomic.
 */
export function supersedeMemory(
  db: Database.Database,
  oldId: number,
  fact: NewFact
): InsertResult {
  const old = db
    .prepare(`SELECT id, asserted_at FROM memories WHERE id = ?`)
    .get(oldId) as { id: number; asserted_at: string | null } | undefined;
  if (!old) {
    throw new Error(`supersedeMemory: memory ${oldId} not found`);
  }
  if (fact.assertedAt && old.asserted_at && fact.assertedAt < old.asserted_at) {
    throw new Error(
      `supersedeMemory: refusing to supersede memory ${oldId} with an older assertion ` +
        `(${fact.assertedAt} < ${old.asserted_at})`
    );
  }

  const now = (fact.now ?? new Date()).toISOString();
  const run = db.transaction((): InsertResult => {
    const result = insertFact(db, fact);
    // If the "new" fact deduped onto the old row itself there is nothing to
    // supersede — never let a row supersede itself.
    if (result.id !== oldId) {
      db.prepare(
        `UPDATE memories SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?`
      ).run(result.id, now, oldId);
    }
    return result;
  });
  return run();
}

/** Loads active memory rows by id (entity-linked-fact retrieval). */
export function getMemoriesByIds(db: Database.Database, ids: number[]): MemoryRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE status = 'active' AND id IN (${placeholders})`
    )
    .all(...ids) as MemoryDbRow[];
  return rows.map(mapMemoryRow);
}

/** Most recently created active memories, newest first. */
export function recentMemories(db: Database.Database, limit = 20): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE status = 'active' ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .all(limit) as MemoryDbRow[];
  return rows.map(mapMemoryRow);
}

/** Reads an ingestion cursor (e.g. a Gmail historyId). Null when unset. */
export function getCursor(db: Database.Database, source: string): string | null {
  const row = db
    .prepare(`SELECT cursor FROM ingest_cursors WHERE source = ?`)
    .get(source) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

/** Upserts an ingestion cursor (race-safe ON CONFLICT, joinStore pattern). */
export function setCursor(
  db: Database.Database,
  source: string,
  cursor: string,
  now: Date = new Date()
): void {
  db.prepare(
    `INSERT INTO ingest_cursors (source, cursor, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       cursor = excluded.cursor,
       updated_at = excluded.updated_at`
  ).run(source, cursor, now.toISOString());
}

/** Records a document as ingested. Duplicate marks update the timestamp. */
export function markIngested(
  db: Database.Database,
  docId: string,
  nowMs: number = Date.now()
): void {
  db.prepare(
    `INSERT INTO ingested_docs (doc_id, ingested_at)
     VALUES (?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET ingested_at = excluded.ingested_at`
  ).run(docId, nowMs);
}

/** True when the document has already been ingested. */
export function isIngested(db: Database.Database, docId: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS hit FROM ingested_docs WHERE doc_id = ?`)
    .get(docId);
  return row !== undefined;
}

/** Deletes ingest-dedup rows strictly older than `cutoffMs` (TTL purge). */
export function purgeIngested(db: Database.Database, cutoffMs: number): number {
  return db
    .prepare(`DELETE FROM ingested_docs WHERE ingested_at < ?`)
    .run(cutoffMs).changes;
}
