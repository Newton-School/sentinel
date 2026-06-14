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

/**
 * A trailing attribution parenthetical that `memory_store` (and similar paths)
 * bake into fact text — e.g. `… (stated by Dipesh, 2026-06-15).` Provenance is
 * metadata, not fact content, so it must not participate in dedup identity:
 * left in, it changes the content hash AND dilutes token-set similarity, so the
 * same statement stored manually (with the suffix) and re-extracted by the
 * conversation hook (without it) double-captures. Only strips parentheticals
 * carrying a provenance cue, so a meaningful trailing parenthetical survives.
 */
const PROVENANCE_SUFFIX =
  /\s*\([^)]*\b(stated|said|updated|corrected|noted|reported|added|confirmed|recorded|per)\b[^)]*\)\s*[.!?]?\s*$/i;

/**
 * Strips a trailing provenance parenthetical for dedup-key purposes. Returns
 * the original text unchanged when no provenance cue is present, or when
 * stripping would leave nothing (a fact that is ONLY provenance).
 */
export function stripProvenanceSuffix(text: string): string {
  const stripped = text.replace(PROVENANCE_SUFFIX, "").trim();
  return stripped.length > 0 ? stripped : text;
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
