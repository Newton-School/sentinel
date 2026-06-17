/**
 * Routing decision for an incoming message: skill > analytics > general.
 *
 * Skills are matched first because a verbatim trigger phrase is an unambiguous
 * intent — free to detect and worth short-circuiting the (paid) classifier.
 * Otherwise the LLM intent classifier decides analytics vs general. Pure and
 * config-free: the ANALYTICS_ENABLED gate lives at the call site (index.ts), so
 * when disabled the classifier is never even invoked.
 */

import { matchSkill, type SkillId } from "./skills.js";
import { classifyAnalyticsIntent, type ClassifyOptions } from "./classifier.js";

export type RouteDecision =
  | { kind: "skill"; skill: SkillId; month: string }
  | { kind: "analytics" }
  | { kind: "general" };

export async function decideRoute(
  text: string,
  opts?: ClassifyOptions
): Promise<RouteDecision> {
  const skill = matchSkill(text);
  if (skill) return { kind: "skill", skill: skill.skill, month: skill.month };

  const intent = await classifyAnalyticsIntent(text, opts);
  return intent === "analytics" ? { kind: "analytics" } : { kind: "general" };
}
