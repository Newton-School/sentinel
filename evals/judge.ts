/**
 * LLM-as-judge for the eval harness. Reuses the production structured-output
 * client (extractJson) but with recordTrace:false so judging the bot's output
 * never pollutes the production llm_calls trace table.
 *
 * Judging is ADVISORY: it complements the deterministic precision/recall in
 * score.ts. A judge failure (no key, HTTP error, unparseable score) yields
 * `null` — the caller treats that as "skipped", never as a hard failure.
 */

import { extractJson } from "../src/llm/openaiClient.js";
import { promptHash } from "../src/prompts/hash.js";

/** Static judge instructions (versioned via {@link judgePromptVersionId}). */
export const JUDGE_SYSTEM =
  "You are a strict, fair evaluation judge for an internal company assistant.\n" +
  "Score how well the CANDIDATE satisfies the GOAL and every RUBRIC item.\n" +
  "Reward correctness, evidence/citations, and stated confidence; penalize fabrication and unsupported claims.\n" +
  'Return {"score": number 0..1, "pass": boolean, "rationale": string}. ' +
  "Set pass=true only when the candidate satisfies the rubric well (score >= 0.7).";

const JUDGE_VERSION = "1.0.0";

/** "judge@<version>+<hash>" — recorded with each eval run for traceability. */
export function judgePromptVersionId(): string {
  return `judge@${JUDGE_VERSION}+${promptHash(JUDGE_SYSTEM)}`;
}

const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "number" },
    pass: { type: "boolean" },
    rationale: { type: "string" },
  },
  required: ["score", "pass", "rationale"],
  additionalProperties: false,
} as const;

export interface JudgeResult {
  score: number;
  pass: boolean;
  rationale: string;
}

export interface JudgeDeps {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

async function runJudge(user: string, deps: JudgeDeps): Promise<JudgeResult | null> {
  const raw = await extractJson({
    system: JUDGE_SYSTEM,
    user,
    schema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    recordTrace: false, // eval judging must not pollute production traces
  });
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.score !== "number" || typeof r.pass !== "boolean" || typeof r.rationale !== "string") {
    return null;
  }
  return { score: clamp01(r.score), pass: r.pass, rationale: r.rationale };
}

/** Judge a candidate answer against a goal question + rubric. */
export function judgeAnswer(opts: {
  question: string;
  candidate: string;
  rubric: string[];
  deps: JudgeDeps;
}): Promise<JudgeResult | null> {
  const user =
    `GOAL (question): ${opts.question}\n\n` +
    `RUBRIC:\n${opts.rubric.map((r) => `- ${r}`).join("\n")}\n\n` +
    `CANDIDATE ANSWER:\n${opts.candidate}`;
  return runJudge(user, opts.deps);
}

/** Judge extracted facts against the expected (golden) facts. Advisory. */
export function judgeExtraction(opts: {
  content: string;
  expected: Array<{ text: string; category: string }>;
  actual: Array<{ text: string; category: string }>;
  deps: JudgeDeps;
}): Promise<JudgeResult | null> {
  const fmt = (fs: Array<{ text: string; category: string }>) =>
    fs.map((f) => `- [${f.category}] ${f.text}`).join("\n") || "(none)";
  const user =
    `SOURCE CONTENT:\n${opts.content}\n\n` +
    `EXPECTED FACTS:\n${fmt(opts.expected)}\n\n` +
    `EXTRACTED FACTS:\n${fmt(opts.actual)}\n\n` +
    "Score whether the extracted facts capture the expected facts without fabricating extras.";
  return runJudge(user, opts.deps);
}
