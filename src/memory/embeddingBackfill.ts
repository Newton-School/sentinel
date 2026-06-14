/**
 * Batched embedding backfill: embeds active, non-sensitive memory rows that
 * lack a vector, in one OpenAI request per batch. This is the sole mechanism
 * that populates `memories.embedding` — efficient (batched), budget-aware (the
 * embedder's daily cap), and privacy-safe (sensitive rows are excluded at the
 * SQL layer, so their text never leaves the box). New facts are picked up on
 * the next pass; a manual CLI seeds history.
 */

import type Database from "better-sqlite3";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { recordEmbedding } from "../metrics/registry.js";
import { memoriesMissingEmbedding, setEmbedding } from "./memorySql.js";
import { embedTexts, floatToBlob } from "./embedder.js";

const log = createLogger("embedding-backfill");

/** True when hybrid embeddings should run (runtime flag + a configured key). */
export function isEmbeddingsEnabled(): boolean {
  return process.env.MEMORY_EMBEDDINGS === "1" && Boolean(config.MEMORY_EMBEDDING_API_KEY);
}

export interface EmbeddingBackfillDeps {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Max rows per pass (one batched request). */
  limit?: number;
}

export interface EmbeddingBackfillResult {
  scanned: number;
  embedded: number;
}

/**
 * Embeds up to `limit` missing-embedding rows in a single batched request.
 * Returns counts. Never throws (the embedder resolves null on any failure).
 */
export async function backfillEmbeddings(
  db: Database.Database,
  deps: EmbeddingBackfillDeps
): Promise<EmbeddingBackfillResult> {
  const limit = deps.limit ?? 200;
  const rows = memoriesMissingEmbedding(db, limit);
  if (rows.length === 0) return { scanned: 0, embedded: 0 };

  const vectors = await embedTexts(
    rows.map((r) => r.text),
    { apiKey: deps.apiKey, model: deps.model, fetchImpl: deps.fetchImpl, now: deps.now }
  );

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const v = vectors[i];
    if (v) {
      setEmbedding(db, rows[i].id, floatToBlob(v));
      embedded++;
      recordEmbedding("ok");
    } else {
      recordEmbedding("error");
    }
  }
  if (embedded > 0) log.info({ embedded, scanned: rows.length }, "Backfilled embeddings");
  return { scanned: rows.length, embedded };
}
