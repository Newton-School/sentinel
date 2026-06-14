/**
 * Pure entity-resolution ladder: map an extracted surface name (+ optional
 * hard identity keys) to an existing entity, or decide to create a new one.
 *
 * No DB, no I/O — the caller (`entitySql`/`entityStore`) loads candidate
 * entities and applies the decision (create / attach key / record alias).
 * Keeping the decision pure makes the matching policy trivially testable, like
 * `rank.ts`.
 *
 * Anti-fragmentation is the core concern: a wrong merge is worse than a missing
 * link, so an ambiguous fuzzy match resolves to nothing rather than guessing.
 */

import { jaccard, normalizeForHash, tokenSet } from "./textMatch.js";

export type EntityType =
  | "person"
  | "team"
  | "project"
  | "metric"
  | "product"
  | "customer"
  | "vendor"
  | "other";

export interface ResolveInput {
  /** Raw surface form as extracted, e.g. "Rahul S." */
  rawName: string;
  /** Optional type hint from the fact category (owner→person, etc.). */
  type?: EntityType;
  /** Hard identity key — strongest match (persons). */
  slackUserId?: string;
  /** Hard identity key — second strongest. */
  email?: string;
}

export interface EntityCandidate {
  id: number;
  type: EntityType;
  canonicalName: string;
  /** normalizeForHash(canonical_name) */
  normalizedName: string;
  /** Normalized alias surface forms. */
  aliases: string[];
  slackUserId: string | null;
  email: string | null;
}

export type ResolveMatch =
  | "slack_id"
  | "email"
  | "exact_name"
  | "alias"
  | "fuzzy"
  | "none";

export interface ResolveDecision {
  match: ResolveMatch;
  /** Set when `match` resolved to an existing entity. */
  entityId?: number;
  /** Confidence in the decision (or in a created entity), in [0, 1]. */
  confidence: number;
  /** True when `match === 'none'` and the name is creation-worthy. */
  shouldCreate: boolean;
  /** Normalized surface form to attach as an alias on a fuzzy match. */
  newAlias?: string;
}

/** Soft-overlap similarity at/above which a single candidate is a fuzzy match. */
export const FUZZY_THRESHOLD = 0.6;

const CONFIDENCE = {
  slackId: 1.0,
  email: 0.97,
  exactName: 0.9,
  alias: 0.85,
  createWithKey: 0.9,
  createNameOnly: 0.5,
} as const;

/**
 * Two name tokens "match" when equal, or when the shorter is a prefix of the
 * longer — this catches initials/abbreviations ("s" ↔ "sharma", "ra" ↔
 * "rahul") that a plain set-intersection Jaccard misses.
 */
function tokenMatches(x: string, y: string): boolean {
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 1 && long.startsWith(short);
}

/**
 * Symmetric soft overlap in [0, 1]: the fraction of tokens on both sides that
 * have a matching counterpart (via {@link tokenMatches}). Falls back to plain
 * Jaccard semantics for fully-equal token sets.
 */
function softSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const at = [...a];
  const bt = [...b];
  let matchedA = 0;
  for (const x of at) if (bt.some((y) => tokenMatches(x, y))) matchedA++;
  let matchedB = 0;
  for (const y of bt) if (at.some((x) => tokenMatches(x, y))) matchedB++;
  return (matchedA + matchedB) / (a.size + b.size);
}

/** Maps a fuzzy similarity in [threshold, 1] to a confidence in [0.6, 0.8). */
function fuzzyConfidence(sim: number): number {
  const span = (sim - FUZZY_THRESHOLD) / (1 - FUZZY_THRESHOLD);
  return 0.6 + Math.min(Math.max(span, 0), 1) * 0.2;
}

export function resolveEntity(
  input: ResolveInput,
  candidates: EntityCandidate[]
): ResolveDecision {
  const slackUserId = input.slackUserId?.trim() || undefined;
  const email = input.email?.trim().toLowerCase() || undefined;
  const normalized = normalizeForHash(input.rawName);
  const hasHardKey = Boolean(slackUserId || email);

  // 1. slack_user_id exact (strongest).
  if (slackUserId) {
    const hit = candidates.find((c) => c.slackUserId === slackUserId);
    if (hit) {
      return { match: "slack_id", entityId: hit.id, confidence: CONFIDENCE.slackId, shouldCreate: false };
    }
  }

  // 2. email exact.
  if (email) {
    const hit = candidates.find((c) => c.email && c.email.toLowerCase() === email);
    if (hit) {
      return { match: "email", entityId: hit.id, confidence: CONFIDENCE.email, shouldCreate: false };
    }
  }

  // Name-based matching needs a non-empty normalized name.
  if (normalized.length > 0) {
    // Honor the type hint when it yields any same-type candidate; otherwise
    // fall back to the full pool so a missing hint never blocks a match.
    const typed = input.type ? candidates.filter((c) => c.type === input.type) : candidates;
    const pool = typed.length > 0 ? typed : candidates;

    // 3. exact normalized name.
    const exact = pool.find((c) => c.normalizedName === normalized);
    if (exact) {
      return { match: "exact_name", entityId: exact.id, confidence: CONFIDENCE.exactName, shouldCreate: false };
    }

    // 4. exact alias.
    const aliasHit = pool.find((c) => c.aliases.includes(normalized));
    if (aliasHit) {
      return { match: "alias", entityId: aliasHit.id, confidence: CONFIDENCE.alias, shouldCreate: false };
    }

    // 5. fuzzy soft-overlap.
    const newTokens = tokenSet(normalized);
    const scored = pool
      .map((c) => ({ c, sim: softSimilarity(newTokens, tokenSet(c.normalizedName)) }))
      .filter((s) => s.sim >= FUZZY_THRESHOLD)
      .sort((a, b) => b.sim - a.sim);

    if (scored.length === 1) {
      return {
        match: "fuzzy",
        entityId: scored[0].c.id,
        confidence: fuzzyConfidence(scored[0].sim),
        shouldCreate: false,
        newAlias: normalized,
      };
    }
    if (scored.length >= 2) {
      // Ambiguous: ≥2 candidates clear the threshold and the hard keys (which
      // would break the tie) were already consumed above. Record nothing.
      return { match: "none", confidence: 0, shouldCreate: false };
    }
  }

  // 6. No match → create, gated. Create only with a hard key (a known person)
  // or a ≥2-token name; a bare single token with no key is too ambiguous.
  const tokenCount = normalized.length > 0 ? normalized.split(" ").length : 0;
  const shouldCreate = hasHardKey || tokenCount >= 2;
  const confidence = shouldCreate
    ? hasHardKey
      ? CONFIDENCE.createWithKey
      : CONFIDENCE.createNameOnly
    : 0;
  return { match: "none", confidence, shouldCreate };
}

// jaccard is re-exported for callers that want the raw set metric (the near-dup
// gate uses it directly via textMatch).
export { jaccard };
