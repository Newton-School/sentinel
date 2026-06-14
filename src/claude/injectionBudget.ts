/**
 * Pure tiered budget allocator for company-brain prompt injection.
 *
 * Replaces the single flat memory blob with a two-tier render — entity-linked
 * facts (the focused, query-named context) first, then general query facts —
 * each under a char cap, with unused entity headroom rolling into the query
 * tier and a hard total bound. Whole lines are dropped in rank order once a
 * budget is hit (never half a line). Per-entity dossiers + asker context tiers
 * are added in Phase C.
 *
 * Pure and dependency-light (types only) — testable like rank.ts.
 */

import type { RankedMemory, RetrievalBundle } from "../memory/types.js";

export interface TierBudget {
  /** Char cap for entity-linked facts. */
  entityFacts: number;
  /** Char cap for general query facts. */
  queryFacts: number;
  /** Hard ceiling across all tiers. */
  total: number;
}

/** Modest growth from the old flat 2000-char cap (denser, tiered context). */
export const DEFAULT_TIER_BUDGET: TierBudget = {
  entityFacts: 1400,
  queryFacts: 1600,
  total: 3000,
};

export interface InjectionPlan {
  entityLines: string[];
  queryLines: string[];
  usedChars: number;
}

/** Renders one memory as `- [sourceType, YYYY-MM-DD] text (category)`. */
export function renderMemoryLine(m: RankedMemory): string {
  const date = (m.assertedAt ?? m.createdAt).slice(0, 10);
  return `- [${m.sourceType}, ${date}] ${m.text} (${m.category})`;
}

function fill(facts: RankedMemory[], cap: number): { lines: string[]; used: number } {
  const lines: string[] = [];
  let used = 0;
  for (const f of facts) {
    const line = renderMemoryLine(f);
    if (used + line.length > cap) continue; // drop this line, try the next (rank order)
    lines.push(line);
    used += line.length;
  }
  return { lines, used };
}

/**
 * Allocates lines across tiers. Entity facts fill first (capped at
 * `entityFacts`); the query tier then gets the rest of the `total` budget,
 * absorbing any unused entity headroom.
 */
export function allocateInjection(
  bundle: RetrievalBundle,
  budget: TierBudget = DEFAULT_TIER_BUDGET
): InjectionPlan {
  const entity = fill(bundle.entityFacts, Math.min(budget.entityFacts, budget.total));
  const queryCap = Math.max(0, budget.total - entity.used);
  const query = fill(bundle.queryFacts, queryCap);
  return {
    entityLines: entity.lines,
    queryLines: query.lines,
    usedChars: entity.used + query.used,
  };
}
