/**
 * Extraction-quality eval suite: run the REAL production extractor over a
 * golden case, then score the extracted facts against the expected facts with
 * the deterministic scorer (gating signal) and, optionally, the LLM judge
 * (advisory).
 */

import { extractFacts } from "../src/memory/extractor.js";
import { scoreFacts, type EvalFact, type PrecisionRecall } from "./score.js";
import { judgeExtraction, type JudgeResult, type JudgeDeps } from "./judge.js";

export interface ExtractionCase {
  id: string;
  sourceType: "conversation" | "meeting" | "email";
  sourceLabel: string;
  content: string;
  expected_facts: EvalFact[];
}

export interface ExtractionCaseResult extends PrecisionRecall {
  id: string;
  /** Number of facts the extractor produced. */
  extracted: number;
  /** Advisory LLM-judge verdict, when enabled (null = judge skipped/failed). */
  judge: JudgeResult | null;
}

export interface ExtractionDeps extends JudgeDeps {
  /** Whether to also run the advisory LLM judge. */
  useJudge?: boolean;
}

export async function runExtractionCase(
  c: ExtractionCase,
  deps: ExtractionDeps
): Promise<ExtractionCaseResult> {
  const facts = await extractFacts({
    sourceType: c.sourceType,
    sourceLabel: c.sourceLabel,
    content: c.content,
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl,
  });
  const actual: EvalFact[] = facts.map((f) => ({
    text: f.text,
    category: f.category,
    entities: f.entities,
    subject: f.subject,
  }));

  const pr = scoreFacts(c.expected_facts, actual);
  const judge = deps.useJudge
    ? await judgeExtraction({ content: c.content, expected: c.expected_facts, actual, deps })
    : null;

  return { id: c.id, ...pr, extracted: actual.length, judge };
}
