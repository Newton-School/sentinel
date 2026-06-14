/**
 * Read-time confidence decay for org-graph edges — the persona-decay model
 * (src/persona/personaDecay.ts) applied to `entity_edges`. Stored confidence
 * only grows on reinforcement; this fades edges that stop being reinforced so
 * a reorg self-heals (new edges out-reinforce stale ones) without any
 * scheduled mutation. Pure and `now`-injected.
 *
 * Half-life is longer than persona's 30d because org structure changes slowly.
 */

/** Half-life (days) for org-edge confidence decay. */
export const EDGE_HALF_LIFE_DAYS = 60;

/** Decayed confidence at/above which an edge is considered "real" for display. */
export const EDGE_DISPLAY_THRESHOLD = 0.6;

/**
 * Confidence after exponential decay from `updatedAt` to `now`. A non-positive
 * age (just-updated / clock skew) returns the stored confidence unchanged.
 */
export function decayedEdgeConfidence(
  confidence: number,
  updatedAt: string,
  now: Date,
  halfLifeDays = EDGE_HALF_LIFE_DAYS
): number {
  const ageMs = now.getTime() - new Date(updatedAt).getTime();
  const ageDays = ageMs / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays <= 0) return confidence;
  return confidence * Math.pow(0.5, ageDays / halfLifeDays);
}
