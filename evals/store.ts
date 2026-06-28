/**
 * Persistence for eval-harness results. One row per suite per run in the
 * `eval_runs` table (defined in src/state/db.ts). PR #5 reads the latest row
 * per suite to expose an eval pass-rate gauge.
 */

import { getDb } from "../src/state/db.js";

export interface EvalRunRow {
  runId: string;
  suite: string;
  nCases: number;
  nPass: number;
  meanScore: number;
  promptVersion?: string;
  judgeVersion?: string;
  ranAt: string; // ISO 8601 UTC
}

export function recordEvalRun(row: EvalRunRow): void {
  getDb()
    .prepare(
      `INSERT INTO eval_runs
         (run_id, suite, n_cases, n_pass, mean_score, prompt_version, judge_version, ran_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.runId,
      row.suite,
      row.nCases,
      row.nPass,
      row.meanScore,
      row.promptVersion ?? null,
      row.judgeVersion ?? null,
      row.ranAt
    );
}

/** The most recent eval run for a suite (by ran_at), or null if none. */
export function latestEvalRunBySuite(suite: string): EvalRunRow | null {
  const r = getDb()
    .prepare(
      `SELECT run_id, suite, n_cases, n_pass, mean_score, prompt_version, judge_version, ran_at
       FROM eval_runs WHERE suite = ? ORDER BY ran_at DESC, id DESC LIMIT 1`
    )
    .get(suite) as
    | {
        run_id: string;
        suite: string;
        n_cases: number;
        n_pass: number;
        mean_score: number;
        prompt_version: string | null;
        judge_version: string | null;
        ran_at: string;
      }
    | undefined;
  if (!r) return null;
  return {
    runId: r.run_id,
    suite: r.suite,
    nCases: r.n_cases,
    nPass: r.n_pass,
    meanScore: r.mean_score,
    promptVersion: r.prompt_version ?? undefined,
    judgeVersion: r.judge_version ?? undefined,
    ranAt: r.ran_at,
  };
}
