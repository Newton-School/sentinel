/**
 * Harvests 👎'd bot replies into answer-eval dataset candidates, closing the
 * loop from real user feedback to offline evals (PR #3). Emits JSONL on stdout
 * — review the lines, then append the good ones to evals/datasets/answers.jsonl.
 *
 *   npm run feedback:harvest [-- --limit 50]
 */

import { getDb, closeDb } from "../src/state/db.js";
import { harvestNegativeFeedback } from "../src/feedback/store.js";

const DEFAULT_RUBRIC = [
  "Directly answers the question",
  "Cites a source / evidence for its claims",
  "States confidence and any unknowns",
  "Does not fabricate facts",
];

function parseLimit(argv: string[]): number {
  const i = argv.indexOf("--limit");
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 50;
}

function main(): void {
  const limit = parseLimit(process.argv.slice(2));
  getDb();
  const cases = harvestNegativeFeedback(limit);

  for (const c of cases) {
    process.stdout.write(
      JSON.stringify({
        id: `harvested-${c.id}`,
        question: c.question,
        candidate_answer: c.answer,
        rubric: DEFAULT_RUBRIC,
      }) + "\n"
    );
  }

  process.stderr.write(
    `[feedback:harvest] ${cases.length} negative-feedback case(s). ` +
      `Review and append the good ones to evals/datasets/answers.jsonl.\n`
  );
  closeDb();
}

main();
