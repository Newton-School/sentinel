/**
 * Consolidation poll loop (ingestWatcher pattern): periodically rebuilds the
 * dossiers of entities that have accrued enough new facts. Slower cadence than
 * ingestion (dossiers change less often), and bounded per tick so it can't
 * drain the shared daily LLM budget.
 *
 * Gated on the OpenAI key (no key → no-op stop, like the ingest watcher).
 * Kill switch read straight from the env every tick (no rebuild): set
 * MEMORY_CONSOLIDATION=0 to disable. An overlapping-tick guard skips a tick
 * while the previous one is still running (consolidation is LLM-heavy).
 */

import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { getPool } from "../state/db.js";
import { runConsolidation } from "./consolidate.js";
import { backfillEmbeddings, isEmbeddingsEnabled } from "./embeddingBackfill.js";
import { openaiApiKey } from "../llm/openaiClient.js";

const log = createLogger("consolidation-watcher");

export const CONSOLIDATION_INTERVAL_MS = 30 * 60 * 1000; // 30 min

/**
 * Memory-maintenance poll loop: rebuilds due entity dossiers (consolidation)
 * and embeds missing rows (hybrid retrieval). Each step has its OWN gate/key
 * and runs in its own try/catch, so one being off or failing never blocks the
 * other. Starts only if at least one step is enabled. Returns a `stop()`.
 */
export function startConsolidationWatcher(): () => void {
  const llmKey = openaiApiKey();
  if (!llmKey && !isEmbeddingsEnabled()) {
    log.warn("No OpenAI key and embeddings disabled — maintenance watcher disabled");
    return () => {};
  }

  let running = false;
  async function runOnce(): Promise<void> {
    if (running) {
      log.warn("Previous maintenance tick still running — skipping this tick");
      return;
    }
    running = true;
    try {
      // Consolidation (gated on the OpenAI key + its kill switch).
      if (llmKey && process.env.MEMORY_CONSOLIDATION !== "0") {
        try {
          await runConsolidation(getPool(), { apiKey: llmKey });
        } catch (err) {
          log.error({ err }, "Consolidation tick failed");
        }
      }
      // Embedding backfill (gated on the embedding key + MEMORY_EMBEDDINGS).
      if (isEmbeddingsEnabled()) {
        try {
          await backfillEmbeddings(getPool(), {
            apiKey: openaiApiKey(),
            model: config.MEMORY_EMBEDDING_MODEL,
          });
        } catch (err) {
          log.error({ err }, "Embedding backfill tick failed");
        }
      }
    } finally {
      running = false;
    }
  }

  log.info({ intervalMs: CONSOLIDATION_INTERVAL_MS }, "Starting memory-maintenance watcher");
  void runOnce();
  const intervalId = setInterval(() => void runOnce(), CONSOLIDATION_INTERVAL_MS);

  return function stop(): void {
    clearInterval(intervalId);
    log.info("Memory-maintenance watcher stopped");
  };
}
