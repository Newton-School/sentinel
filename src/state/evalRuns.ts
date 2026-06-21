/**
 * Persistence for eval-harness results in the `eval_runs` table (schema in
 * db.ts). Lives in src/ (not evals/) because the production /metrics endpoint
 * reads it for the eval pass-rate gauge; the offline eval runner writes it.
 */

import { getPool } from "./db.js";

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

export async function recordEvalRun(row: EvalRunRow): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO eval_runs
       (run_id, suite, n_cases, n_pass, mean_score, prompt_version, judge_version, ran_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.runId,
      row.suite,
      row.nCases,
      row.nPass,
      row.meanScore,
      row.promptVersion ?? null,
      row.judgeVersion ?? null,
      row.ranAt,
    ]
  );
}

/** The most recent eval run for a suite (by ran_at), or null if none. */
export async function latestEvalRunBySuite(suite: string): Promise<EvalRunRow | null> {
  const pool = getPool();
  const r = (
    await pool.query(
      `SELECT run_id, suite, n_cases, n_pass, mean_score, prompt_version, judge_version, ran_at
       FROM eval_runs WHERE suite = $1 ORDER BY ran_at DESC, id DESC LIMIT 1`,
      [suite]
    )
  ).rows[0] as
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
