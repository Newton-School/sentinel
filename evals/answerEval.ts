/**
 * Answer-quality eval suite: judge a candidate answer (a previously captured
 * bot reply, or a reference answer) against a goal question + rubric using the
 * LLM judge. Offline and CI-safe — it does not run the live agent; it scores
 * answers that already exist in the dataset (PR #4's feedback harvest will grow
 * this dataset from real 👎'd replies).
 */

import { judgeAnswer, type JudgeDeps } from "./judge.js";

export interface AnswerCase {
  id: string;
  question: string;
  candidate_answer: string;
  rubric: string[];
}

export interface AnswerCaseResult {
  id: string;
  /** 0..1 judge score, or null when the judge was skipped/failed. */
  score: number | null;
  /** Judge pass/fail, or null when skipped. */
  pass: boolean | null;
  rationale?: string;
}

export async function runAnswerCase(c: AnswerCase, deps: JudgeDeps): Promise<AnswerCaseResult> {
  const v = await judgeAnswer({
    question: c.question,
    candidate: c.candidate_answer,
    rubric: c.rubric,
    deps,
  });
  if (!v) return { id: c.id, score: null, pass: null };
  return { id: c.id, score: v.score, pass: v.pass, rationale: v.rationale };
}
