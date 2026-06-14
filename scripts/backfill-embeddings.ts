#!/usr/bin/env node

/**
 * One-off (re-runnable) embedding backfill: embeds active, non-sensitive
 * memory rows that lack a vector, via OpenAI, in batches. Seeds history before
 * (or alongside) the maintenance watcher. Sensitive rows are never embedded.
 *
 * Requires MEMORY_EMBEDDING_API_KEY (OpenAI). Respects the embedder's daily
 * budget. Usage:
 *   MEMORY_EMBEDDING_API_KEY=sk-... npx tsx scripts/backfill-embeddings.ts
 *   ... --batch 500 --max 4
 */

import { config } from "../src/config.js";
import { getDb, closeDb } from "../src/state/db.js";
import { backfillEmbeddings } from "../src/memory/embeddingBackfill.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

async function main(): Promise<void> {
  if (!config.MEMORY_EMBEDDING_API_KEY) {
    process.stderr.write("MEMORY_EMBEDDING_API_KEY is not set — nothing to do.\n");
    process.exit(1);
  }
  const batch = arg("--batch", 200);
  const maxBatches = arg("--max", Number.MAX_SAFE_INTEGER);
  const db = getDb();

  let totalScanned = 0;
  let totalEmbedded = 0;
  for (let i = 0; i < maxBatches; i++) {
    const { scanned, embedded } = await backfillEmbeddings(db, {
      apiKey: config.MEMORY_EMBEDDING_API_KEY,
      model: config.MEMORY_EMBEDDING_MODEL,
      limit: batch,
    });
    totalScanned += scanned;
    totalEmbedded += embedded;
    process.stdout.write(`batch ${i + 1}: scanned=${scanned} embedded=${embedded}\n`);
    // Stop when a pass finds nothing, or embedded nothing (e.g. budget hit).
    if (scanned === 0 || embedded === 0) break;
  }
  process.stdout.write(`done: scanned=${totalScanned}, embedded=${totalEmbedded}\n`);
  closeDb();
}

void main();
