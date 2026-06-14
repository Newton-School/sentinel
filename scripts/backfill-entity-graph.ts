#!/usr/bin/env node

/**
 * One-off (re-runnable) backfill of the company-brain entity graph from the
 * existing memory history: resolves the free-text `entities` of active
 * memories into `entities` rows + `memory_entities` links.
 *
 * Safe to run before flipping MEMORY_ENTITY_GRAPH on (it calls the backfill
 * directly, independent of the live linking flag), and safe to re-run after a
 * resolver/merge change to repair attributions — the NOT EXISTS guard skips
 * already-linked rows.
 *
 * Usage:
 *   npx tsx scripts/backfill-entity-graph.ts            # drain in batches of 500
 *   npx tsx scripts/backfill-entity-graph.ts --batch 200
 *   npx tsx scripts/backfill-entity-graph.ts --max 1    # a single batch then stop
 */

import { getDb, closeDb } from "../src/state/db.js";
import { backfillEntityLinks } from "../src/memory/entityLink.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) {
    const n = parseInt(process.argv[i + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallback;
}

function main(): void {
  const batch = arg("--batch", 500);
  const maxBatches = arg("--max", Number.MAX_SAFE_INTEGER);
  const db = getDb();

  let totalScanned = 0;
  let totalLinked = 0;
  let batches = 0;
  // Each pass only sees rows still missing links, so once a pass scans 0 the
  // backfill is complete.
  for (; batches < maxBatches; batches++) {
    const { scanned, linked } = backfillEntityLinks(db, { limit: batch });
    totalScanned += scanned;
    totalLinked += linked;
    process.stdout.write(
      `batch ${batches + 1}: scanned=${scanned} linked=${linked}\n`
    );
    if (scanned === 0) break;
  }

  process.stdout.write(
    `done: ${batches} batch(es), scanned=${totalScanned}, linked=${totalLinked}\n`
  );
  closeDb();
}

main();
