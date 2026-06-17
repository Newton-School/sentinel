/**
 * Offline eval-harness runner. `npm run eval` scores extraction quality
 * (deterministic precision/recall + advisory judge) and answer quality
 * (LLM judge against a rubric) over golden datasets, persists a row per suite
 * to eval_runs, writes a JSON report, and (with --gate) exits non-zero when a
 * suite's mean score is below the threshold.
 *
 * No Slack. It does make real OpenAI calls when an API key is present (that's
 * the point — it exercises the production extractor + a judge); point
 * SQLITE_DB_PATH at a throwaway DB for ad-hoc runs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runWithTrace } from "../src/llm/traceContext.js";
import { isDbOpen, getDb } from "../src/state/db.js";
import { openaiApiKey } from "../src/llm/openaiClient.js";
import { activePromptVersionId } from "../src/prompts/registry.js";
import { runExtractionCase, type ExtractionCase } from "./extractionEval.js";
import { runAnswerCase, type AnswerCase } from "./answerEval.js";
import { judgePromptVersionId } from "./judge.js";
import { recordEvalRun } from "./store.js";

export type SuiteName = "extraction" | "answers" | "all";

export interface EvalArgs {
  suite: SuiteName;
  gate: boolean;
  threshold: number;
  useJudge: boolean;
  datasetDir: string;
}

export interface RunEvalsOptions {
  runId: string;
  ranAt: string; // ISO 8601 UTC
  extraction?: ExtractionCase[];
  answers?: AnswerCase[];
  deps: { apiKey?: string; fetchImpl?: typeof fetch; now?: () => number; useJudge?: boolean };
  threshold: number;
  persist?: boolean;
}

export interface SuiteReport {
  suite: string;
  nCases: number;
  nPass: number;
  meanScore: number;
  passed: boolean;
  cases: Array<Record<string, unknown>>;
}

export interface EvalReport {
  runId: string;
  ranAt: string;
  threshold: number;
  suites: SuiteReport[];
  passed: boolean;
}

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Parse CLI flags. Defaults: all suites, no gate, threshold 0.8, judge off. */
export function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = { suite: "all", gate: false, threshold: 0.8, useJudge: false, datasetDir: "evals/datasets" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--gate") args.gate = true;
    else if (a === "--judge") args.useJudge = true;
    else if (a === "--suite") args.suite = argv[++i] as SuiteName;
    else if (a === "--threshold") args.threshold = Number(argv[++i]);
    else if (a === "--dataset-dir") args.datasetDir = argv[++i];
  }
  return args;
}

/** Runs the selected suites and returns a structured report. */
export async function runEvals(opts: RunEvalsOptions): Promise<EvalReport> {
  return runWithTrace({ traceId: `eval:${opts.runId}` }, async () => {
    const suites: SuiteReport[] = [];

    if (opts.extraction && opts.extraction.length > 0) {
      const cases = [];
      for (const c of opts.extraction) {
        cases.push(await runExtractionCase(c, { ...opts.deps, useJudge: opts.deps.useJudge }));
      }
      const nPass = cases.filter((c) => c.f1 >= opts.threshold).length;
      const meanScore = mean(cases.map((c) => c.f1));
      suites.push({ suite: "extraction", nCases: cases.length, nPass, meanScore, passed: meanScore >= opts.threshold, cases });
      if (opts.persist && isDbOpen()) {
        recordEvalRun({
          runId: opts.runId,
          suite: "extraction",
          nCases: cases.length,
          nPass,
          meanScore,
          promptVersion: activePromptVersionId("extraction"),
          judgeVersion: opts.deps.useJudge ? judgePromptVersionId() : undefined,
          ranAt: opts.ranAt,
        });
      }
    }

    if (opts.answers && opts.answers.length > 0) {
      const cases = [];
      for (const c of opts.answers) cases.push(await runAnswerCase(c, opts.deps));
      const nPass = cases.filter((c) => c.pass === true).length;
      const meanScore = mean(cases.map((c) => c.score ?? 0));
      suites.push({ suite: "answers", nCases: cases.length, nPass, meanScore, passed: meanScore >= opts.threshold, cases });
      if (opts.persist && isDbOpen()) {
        recordEvalRun({
          runId: opts.runId,
          suite: "answers",
          nCases: cases.length,
          nPass,
          meanScore,
          judgeVersion: judgePromptVersionId(),
          ranAt: opts.ranAt,
        });
      }
    }

    return { runId: opts.runId, ranAt: opts.ranAt, threshold: opts.threshold, suites, passed: suites.every((s) => s.passed) };
  });
}

/** Human-readable one-line-per-suite summary. */
export function formatReport(report: EvalReport): string {
  const lines = [`eval run ${report.runId} (threshold ${report.threshold})`];
  for (const s of report.suites) {
    lines.push(
      `  ${s.passed ? "PASS" : "FAIL"} ${s.suite.padEnd(11)} mean=${s.meanScore.toFixed(3)} pass=${s.nPass}/${s.nCases}`
    );
  }
  lines.push(`  => ${report.passed ? "PASSED" : "FAILED"}`);
  return lines.join("\n");
}

function loadJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = openaiApiKey();
  if (!apiKey) {
    console.warn("[eval] No OpenAI API key — extraction/judge calls will be skipped (scores will be 0).");
  }

  const wantExtraction = args.suite === "all" || args.suite === "extraction";
  const wantAnswers = args.suite === "all" || args.suite === "answers";
  const extraction = wantExtraction ? loadJsonl<ExtractionCase>(join(args.datasetDir, "extraction.jsonl")) : [];
  const answers = wantAnswers ? loadJsonl<AnswerCase>(join(args.datasetDir, "answers.jsonl")) : [];

  getDb(); // open so eval_runs persistence is enabled

  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const ranAt = new Date().toISOString();

  const report = await runEvals({
    runId,
    ranAt,
    extraction,
    answers,
    deps: { apiKey, useJudge: args.useJudge },
    threshold: args.threshold,
    persist: true,
  });

  const resultsDir = "evals/results";
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, `${runId}.json`), JSON.stringify(report, null, 2));

  console.log(formatReport(report));
  console.log(`[eval] wrote ${join(resultsDir, `${runId}.json`)}`);

  if (args.gate && !report.passed) {
    console.error("[eval] gate FAILED — a suite scored below the threshold");
    process.exitCode = 1;
  }
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}
