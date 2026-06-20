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

import type {
  EntityDossierRef,
  RankedMemory,
  RetrievalBundle,
} from "../memory/types.js";

export interface TierBudget {
  /** Char cap for consolidated entity dossiers. */
  dossiers: number;
  /** Char cap for entity-linked raw facts. */
  entityFacts: number;
  /** Char cap for general query facts. */
  queryFacts: number;
  /** Hard ceiling across all tiers. */
  total: number;
}

/** Tiered budget (denser, condensed dossiers first), total ~3000 chars. */
export const DEFAULT_TIER_BUDGET: TierBudget = {
  dossiers: 1200,
  entityFacts: 800,
  queryFacts: 1000,
  total: 3000,
};

export interface InjectionPlan {
  dossierBlocks: string[];
  entityLines: string[];
  queryLines: string[];
  usedChars: number;
}

/** Renders one memory as `- [sourceType, YYYY-MM-DD] text (category)`. */
export function renderMemoryLine(m: RankedMemory): string {
  const date = (m.assertedAt ?? m.createdAt).slice(0, 10);
  return `- [${m.sourceType}, ${date}] ${m.text} (${m.category})`;
}

/** Renders a dossier as a single condensed line: `- [dossier: Name — updated date] body`. */
export function renderDossier(d: EntityDossierRef): string {
  const date = d.builtAt.slice(0, 10);
  const body = d.profileMd.replace(/\s*\n\s*/g, " ").trim();
  return `- [dossier: ${d.name} — updated ${date}] ${body}`;
}

function fillLines(lines: string[], cap: number): { kept: string[]; used: number } {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > cap) continue; // drop whole line, try next (rank order)
    kept.push(line);
    used += line.length;
  }
  return { kept, used };
}

/**
 * Allocates lines across tiers in priority order — dossiers (most condensed),
 * then entity-linked facts, then general query facts — each capped, with each
 * tier's unused headroom rolling into the next via the shared `total` bound.
 */
export function allocateInjection(
  bundle: RetrievalBundle,
  budget: TierBudget = DEFAULT_TIER_BUDGET
): InjectionPlan {
  const dossierLines = (bundle.dossiers ?? []).map(renderDossier);
  const dossier = fillLines(dossierLines, Math.min(budget.dossiers, budget.total));

  const entityCap = Math.min(budget.entityFacts, budget.total - dossier.used);
  const entity = fillLines(bundle.entityFacts.map(renderMemoryLine), Math.max(0, entityCap));

  const queryCap = Math.max(0, budget.total - dossier.used - entity.used);
  const query = fillLines(bundle.queryFacts.map(renderMemoryLine), queryCap);

  return {
    dossierBlocks: dossier.kept,
    entityLines: entity.kept,
    queryLines: query.kept,
    usedChars: dossier.used + entity.used + query.used,
  };
}
