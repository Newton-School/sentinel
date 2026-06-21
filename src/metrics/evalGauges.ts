/**
 * Prometheus gauges for offline eval results, read from the eval_runs table at
 * scrape time (the eval runner is a separate process, so its results can't live
 * in the in-memory registry). Composed into the /metrics output alongside
 * renderPrometheus. Best-effort: any DB error yields an empty string so a
 * scrape never fails.
 */

import { latestEvalRunBySuite } from "../state/evalRuns.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("eval-gauges");

const SUITES = ["extraction", "answers", "analytics"] as const;

function fmt(n: number): string {
  return String(n);
}

export async function renderEvalGauges(): Promise<string> {
  try {
    const ratios: string[] = [];
    const scores: string[] = [];
    for (const suite of SUITES) {
      const run = await latestEvalRunBySuite(suite);
      if (!run) continue;
      const ratio = run.nCases === 0 ? 0 : run.nPass / run.nCases;
      ratios.push(`sentinel_eval_pass_ratio{suite="${suite}"} ${fmt(ratio)}`);
      scores.push(`sentinel_eval_mean_score{suite="${suite}"} ${fmt(run.meanScore)}`);
    }
    if (ratios.length === 0) return "";

    return [
      "# HELP sentinel_eval_pass_ratio Fraction of eval cases passing in the latest run, by suite",
      "# TYPE sentinel_eval_pass_ratio gauge",
      ...ratios,
      "# HELP sentinel_eval_mean_score Mean eval score in the latest run, by suite",
      "# TYPE sentinel_eval_mean_score gauge",
      ...scores,
      "",
    ].join("\n");
  } catch (err) {
    log.warn({ err }, "renderEvalGauges failed (non-fatal)");
    return "";
  }
}
