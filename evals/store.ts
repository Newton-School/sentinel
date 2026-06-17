/**
 * Eval-run persistence. The implementation lives in src/state/evalRuns.ts
 * (the production /metrics gauge reads it too); this re-export keeps the
 * `evals/store.js` import path stable for the runner and tests.
 */
export { recordEvalRun, latestEvalRunBySuite, type EvalRunRow } from "../src/state/evalRuns.js";
