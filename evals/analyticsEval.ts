/**
 * LIVE analytics eval suite. Unlike the offline answer suite, this drives the
 * REAL analytics path for each case — the same building blocks index.ts uses:
 *   decideRoute (real classifier routing)
 *   → buildAnalyticsSystemPrompt
 *   → runReply (the configured harness) with the Metabase-only MCP toolset
 * then grades the answer with the LLM judge against ground truth computed from
 * the brain's canonical SQL (computeGroundTruth → Altius). Projection requests
 * route to analytics like any data question (the brain carries the procedures).
 *
 * It therefore needs Metabase creds + a live reply harness (OpenAI or CLI); it
 * is opt-in (never part of the default `npm run eval`). External calls are
 * injectable (deps) so the unit test exercises the control flow with no real
 * harness/network.
 */

import { runReply } from "../src/agent/replyRunner.js";
import { buildAnalyticsSystemPrompt } from "../src/claude/systemPrompt.js";
import { decideRoute, type RouteDecision } from "../src/analytics/router.js";
import { activePromptVersionId } from "../src/prompts/registry.js";
import { computeGroundTruth } from "./groundTruth.js";
import { judgeAnswer, type JudgeDeps } from "./judge.js";
import type { PersonaProfile, PersonaTrait } from "../src/persona/types.js";

export type ExpectedRoute = "analytics" | "general";
export type Graded = "ground_truth" | "rubric" | "routing_only";

export interface AnalyticsCase {
  id: string;
  question: string;
  tags?: string[];
  expectedRoute: ExpectedRoute;
  graded: Graded;
  rubric: string[];
  /** Canonical SQL (run on Altius) whose result is the ground-truth value. */
  groundTruthSql?: string;
}

export interface AnalyticsCaseResult {
  id: string;
  expectedRoute: ExpectedRoute;
  /** The route the production router actually chose for this question. */
  route: ExpectedRoute;
  routeOk: boolean;
  answer?: string;
  groundTruth?: string | null;
  /** 0..1 judge score, or null when the judge was skipped/failed. */
  score: number | null;
  /** Final pass = judge pass AND correct routing; null when judge skipped. */
  pass: boolean | null;
  rationale?: string;
  costUsd?: number;
  latencyMs?: number;
}

/** Injectable seams so the unit test never spawns a CLI or hits the network. */
export interface AnalyticsDeps {
  /** Judge + classifier credentials (OpenAI). */
  judge: JudgeDeps;
  /** Optional model pin for the analytics route (config.ANALYTICS_MODEL). */
  model?: string;
  decide?: typeof decideRoute;
  run?: typeof runReply;
  judgeFn?: typeof judgeAnswer;
  groundTruthFn?: typeof computeGroundTruth;
}

const EVAL_PERSONA: PersonaProfile = {
  userId: "eval",
  displayName: "Eval Harness",
  role: "Data Analyst",
  createdAt: "",
  updatedAt: "",
};
const EVAL_TRAITS: PersonaTrait[] = [];
const ANALYTICS_MCP_SERVERS = new Set(["metabase"]);

/** Map a RouteDecision to the dataset's ExpectedRoute string. */
export function routeToExpected(route: RouteDecision): ExpectedRoute {
  return route.kind;
}

export async function runAnalyticsCase(
  c: AnalyticsCase,
  deps: AnalyticsDeps
): Promise<AnalyticsCaseResult> {
  const decide = deps.decide ?? decideRoute;
  const run = deps.run ?? runReply;
  const judge = deps.judgeFn ?? judgeAnswer;
  const groundTruthFn = deps.groundTruthFn ?? computeGroundTruth;

  // Exercise the REAL router (classifier reuses the same OpenAI key as the judge).
  const route = await decide(c.question, { apiKey: deps.judge.apiKey, ...(deps.judge.fetchImpl ? { fetchImpl: deps.judge.fetchImpl } : {}) });
  const actual = routeToExpected(route);
  const routeOk = actual === c.expectedRoute;

  // Routing-only cases assert the route alone — no agent run, no judge.
  if (c.graded === "routing_only") {
    return {
      id: c.id,
      expectedRoute: c.expectedRoute,
      route: actual,
      routeOk,
      score: routeOk ? 1 : 0,
      pass: routeOk,
      rationale: routeOk ? "routed as expected" : `expected ${c.expectedRoute}, got ${actual}`,
    };
  }

  // Build the analytics system prompt with the production helper.
  const systemPrompt = buildAnalyticsSystemPrompt(EVAL_PERSONA, EVAL_TRAITS);
  const promptVersion = activePromptVersionId("analytics");

  const runOpts = {
    mcpServers: ANALYTICS_MCP_SERVERS,
    ...(deps.model ? { model: deps.model } : {}),
  };

  let answer = "";
  let costUsd: number | undefined;
  let latencyMs: number | undefined;
  try {
    const resp = await run(systemPrompt, c.question, undefined, undefined, promptVersion, runOpts);
    answer = resp.text ?? "";
    costUsd = resp.costUsd;
    latencyMs = resp.durationMs;
  } catch (err) {
    return {
      id: c.id,
      expectedRoute: c.expectedRoute,
      route: actual,
      routeOk,
      answer: "",
      score: 0,
      pass: false,
      rationale: `agent run failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const groundTruth = c.groundTruthSql ? await groundTruthFn(c.groundTruthSql) : undefined;

  const verdict = await judge({
    question: c.question,
    candidate: answer,
    rubric: c.rubric,
    ...(groundTruth ? { groundTruth } : {}),
    deps: deps.judge,
  });

  if (!verdict) {
    return { id: c.id, expectedRoute: c.expectedRoute, route: actual, routeOk, answer, groundTruth, score: null, pass: null, costUsd, latencyMs };
  }

  return {
    id: c.id,
    expectedRoute: c.expectedRoute,
    route: actual,
    routeOk,
    answer,
    groundTruth,
    score: verdict.score,
    // A correct number with a wrong route still fails — routing is part of the contract.
    pass: verdict.pass && routeOk,
    rationale: verdict.rationale,
    costUsd,
    latencyMs,
  };
}
