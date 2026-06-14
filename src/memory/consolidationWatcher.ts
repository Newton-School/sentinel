/**
 * Consolidation poll loop (ingestWatcher pattern): periodically rebuilds the
 * dossiers of entities that have accrued enough new facts. Slower cadence than
 * ingestion (dossiers change less often), and bounded per tick so it can't
 * drain the shared daily LLM budget.
 *
 * Gated on ANTHROPIC_API_KEY (no key → no-op stop, like the ingest watcher).
 * Kill switch read straight from the env every tick (no rebuild): set
 * MEMORY_CONSOLIDATION=0 to disable. An overlapping-tick guard skips a tick
 * while the previous one is still running (consolidation is LLM-heavy).
 */

import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { getDb } from "../state/db.js";
import { runConsolidation } from "./consolidate.js";

const log = createLogger("consolidation-watcher");

export const CONSOLIDATION_INTERVAL_MS = 30 * 60 * 1000; // 30 min

/**
 * Start the consolidation poll loop. Returns a `stop()` that clears the
 * interval; an in-flight tick finishes (it only calls the LLM + writes SQLite).
 */
export function startConsolidationWatcher(): () => void {
  if (!config.ANTHROPIC_API_KEY) {
    log.warn("ANTHROPIC_API_KEY not set — consolidation watcher disabled");
    return () => {};
  }
  const apiKey = config.ANTHROPIC_API_KEY;

  let running = false;
  async function runOnce(): Promise<void> {
    if (process.env.MEMORY_CONSOLIDATION === "0") return;
    if (running) {
      log.warn("Previous consolidation tick still running — skipping this tick");
      return;
    }
    running = true;
    try {
      await runConsolidation(getDb(), { apiKey });
    } catch (err) {
      log.error({ err }, "Consolidation tick failed");
    } finally {
      running = false;
    }
  }

  log.info({ intervalMs: CONSOLIDATION_INTERVAL_MS }, "Starting consolidation watcher");
  void runOnce();
  const intervalId = setInterval(() => void runOnce(), CONSOLIDATION_INTERVAL_MS);

  return function stop(): void {
    clearInterval(intervalId);
    log.info("Consolidation watcher stopped");
  };
}
