/**
 * Pure org-chart edge inference: maps the resolved entities of a single fact to
 * proposed `entity_edges`. Consumed by `linkFactEntities`, which upserts each
 * proposed edge so it accrues confidence across corroborating facts (and decays
 * via edgeDecay when it stops being reinforced).
 *
 * Deliberately HIGH-PRECISION / low-volume: edges are derived only from explicit
 * `owner`-category facts whose subject was CONFIDENTLY attributed (≥ the subject
 * floor). This avoids polluting the graph with noisy co-mention guesses. Richer
 * signals (Slack manager field, calendar recurring 1:1s → reports_to/member_of)
 * are a later slice; this slice ships the ownership backbone.
 */

import type { MemoryCategory } from "./types.js";
import type { EntityType } from "./entityResolve.js";
import type { EntityRelation } from "./entitySql.js";

export interface EdgeSignal {
  srcId: number;
  dstId: number;
  relation: EntityRelation;
  confidence: number;
  provenance: string;
  assertedAt?: string;
}

export interface ProposeEdgesInput {
  category: MemoryCategory;
  /** The fact's confidently-attributed subject, or null. */
  subject: { id: number; type: EntityType } | null;
  /** Other entities linked to the fact. */
  others: Array<{ id: number; type: EntityType }>;
  assertedAt?: string;
}

/** Base confidence for a freshly-derived ownership edge (needs corroboration to display). */
const OWNERSHIP_BASE_CONFIDENCE = 0.5;

const OWNABLE: ReadonlySet<EntityType> = new Set(["project", "metric", "product"]);

/**
 * Proposes org edges for one fact. Returns [] unless the fact is an `owner`
 * fact with a confident subject.
 */
export function proposeEdgesForFact(input: ProposeEdgesInput): EdgeSignal[] {
  const { category, subject, others, assertedAt } = input;
  if (category !== "owner" || !subject) return [];

  const provenance = JSON.stringify({ signal: "owner_fact" });
  const edges: EdgeSignal[] = [];
  for (const o of others) {
    if (o.id === subject.id) continue;

    let relation: EntityRelation | null = null;
    if (subject.type === "person" && o.type === "team") {
      relation = "manages";
    } else if (
      (subject.type === "person" || subject.type === "team") &&
      OWNABLE.has(o.type)
    ) {
      relation = "owns";
    }
    if (!relation) continue;

    edges.push({
      srcId: subject.id,
      dstId: o.id,
      relation,
      confidence: OWNERSHIP_BASE_CONFIDENCE,
      provenance,
      assertedAt,
    });
  }
  return edges;
}
