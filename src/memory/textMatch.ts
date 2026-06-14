/**
 * Shared, dependency-free text-matching primitives.
 *
 * Extracted from `memorySql.ts` so both the memory store (content-hash dedup,
 * near-dup gate) and the entity resolver (fuzzy name matching) use the exact
 * same normalization and similarity, rather than drifting apart. Pure: no DB,
 * no config, no logging — trivially unit-testable.
 */

/**
 * Canonical text normalization: lowercase, strip everything but
 * letters/digits/whitespace (unicode-aware), collapse whitespace, trim.
 */
export function normalizeForHash(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Splits already-normalized text into a set of non-empty tokens. */
export function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

/**
 * Token-set Jaccard similarity in [0, 1]. Returns 0 when both sets are empty
 * (no divide-by-zero), matching the memory near-dup gate's behavior.
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}
