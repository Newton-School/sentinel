/**
 * Pure query-sanitization and memory-ranking helpers.
 *
 * Like `personaDecay.ts`, everything here is a pure function with an injected
 * `now` — no DB handles, no logging, no config — so it is trivially testable
 * and safe to reuse from any process (the main bot today, an MCP server later).
 */

import type { MemoryCandidate, RankedMemory } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Half-life (days) of a memory's recency factor in the ranking score. */
export const MEMORY_RECENCY_HALF_LIFE_DAYS = 90;

/** Categories that get a relevance boost: they age better than plain facts. */
const BOOSTED_CATEGORIES = new Set(["decision", "owner", "deadline"]);
const CATEGORY_BOOST = 1.25;

/**
 * Small English + Hinglish stopword list. Tokens shorter than 3 chars are
 * dropped separately, so 1-2 char fillers don't need to be listed.
 */
const STOPWORDS = new Set([
  "the", "and", "are", "was", "were", "been", "being", "for", "with",
  "from", "about", "into", "onto", "over", "under", "out", "off",
  "what", "whats", "which", "who", "whom", "whose", "when", "where",
  "why", "how", "did", "does", "doing", "done", "has", "have", "had",
  "having", "our", "your", "their", "his", "her", "hers", "its",
  "this", "that", "these", "those", "there", "here", "they", "them",
  "then", "than", "any", "all", "some", "such", "not", "nor", "but",
  // NOTE: "may" is deliberately NOT a stopword — founders constantly ask
  // about the month of May, which outweighs the modal-verb noise.
  "can", "cannot", "could", "should", "would", "will", "shall",
  "might", "must", "please", "tell", "give", "show", "get", "got",
  "let", "you", "very", "too", "also", "just", "per", "via", "etc",
  // Hinglish query fillers (e.g. "placements ka update kya hai?")
  "hai", "hain", "kya", "kitna", "kitne", "kaun", "kab", "kahan",
  "karo", "raha", "rahi", "bata", "batao", "chahiye", "mein", "wala", "wale",
]);

/**
 * Static synonym map seeded from the persona tracker's category keyword
 * clusters (src/persona/tracker.ts): placements/finance/admissions/NST
 * vocabulary that founders use interchangeably. Expansion is one hop —
 * curated values are NOT re-expanded.
 */
const SYNONYMS: Record<string, string[]> = {
  // finance / retention cluster
  attrition: ["churn", "dropout"],
  churn: ["attrition", "dropout"],
  dropout: ["attrition", "churn"],
  revenue: ["income"],
  income: ["revenue"],
  spend: ["cost", "expense"],
  cost: ["spend", "expense"],
  expense: ["cost", "spend"],
  // placements cluster
  salary: ["ctc", "package"],
  ctc: ["salary", "package"],
  package: ["ctc", "salary"],
  placement: ["offer", "offers"],
  placements: ["offers", "placement"],
  offer: ["placement"],
  offers: ["placements"],
  recruiter: ["employer"],
  employer: ["recruiter"],
  // admissions cluster
  counselor: ["counsellor"],
  counsellor: ["counselor"],
  counselors: ["counsellor", "counselor"],
  counsellors: ["counselor", "counsellor"],
  inquiry: ["enquiry", "lead"],
  enquiry: ["inquiry", "lead"],
  enrollment: ["admission", "admissions"],
  enrolment: ["admission", "admissions"],
  admission: ["enrollment"],
  admissions: ["enrollment"],
  cohort: ["batch"],
  batch: ["cohort"],
  // student health / ops cluster
  nps: ["satisfaction"],
  satisfaction: ["nps"],
  outage: ["downtime", "incident"],
  downtime: ["outage", "incident"],
};

/**
 * Turns raw user text into a safe FTS5 MATCH expression:
 * lowercase → strip everything but letters/digits/whitespace (unicode-aware)
 * → drop stopwords and tokens shorter than 3 chars → expand via the static
 * synonym map → double-quote each token → join with ` OR `.
 *
 * Because every emitted token is a double-quoted, purely alphanumeric string,
 * apostrophes, hyphens, parens, `AND/OR/NOT/NEAR`, column filters and other
 * FTS operators in the raw text can never make MATCH throw.
 *
 * Returns "" when nothing significant remains.
 */
export function sanitizeFtsQuery(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
  const out: string[] = [];
  const seen = new Set<string>();

  const push = (token: string): void => {
    if (!seen.has(token)) {
      seen.add(token);
      out.push(token);
    }
  };

  for (const token of cleaned.split(/\s+/)) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    push(token);
    for (const synonym of SYNONYMS[token] ?? []) {
      push(synonym);
    }
  }

  return out.map((t) => `"${t}"`).join(" OR ");
}

/**
 * The recency × category × confidence multiplier applied on top of the
 * relevance term. Shared by the BM25-only and hybrid rankers so they age,
 * boost, and weight candidates identically.
 */
function scoreModulator(c: MemoryCandidate, now: Date): number {
  const updatedMs = new Date(c.updatedAt).getTime();
  let ageDays = (now.getTime() - updatedMs) / DAY_MS;
  // Malformed or future timestamps must not zero out a memory: treat as fresh.
  if (Number.isNaN(ageDays) || ageDays < 0) ageDays = 0;
  const recency = Math.pow(0.5, ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);
  const catBoost = BOOSTED_CATEGORIES.has(c.category) ? CATEGORY_BOOST : 1.0;
  return (0.5 + 0.5 * recency) * catBoost * (0.5 + 0.5 * c.confidence);
}

/**
 * Ranks search candidates with a composite score and returns the top `k`.
 *
 *   rel   = -bm                      (SQLite bm25: lower/more negative = better)
 *   score = rel × (0.5 + 0.5·recency) × catBoost × (0.5 + 0.5·confidence)
 *
 * For the LIKE fallback (constant bm) ranking degrades gracefully to
 * recency × category × confidence. Pure: `now` is injected.
 */
export function rankMemories(
  candidates: MemoryCandidate[],
  now: Date,
  k = 6
): RankedMemory[] {
  return candidates
    .map((c) => ({ ...c, score: -c.bm * scoreModulator(c, now) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/** Weight of normalized BM25 vs cosine in the fused relevance (lexical-leaning). */
export const HYBRID_ALPHA = 0.6;

/** Returns a min-max normalizer over `values` (→[0,1]); all-equal/empty → 1. */
function minMaxNormalizer(values: number[]): (x: number) => number {
  if (values.length === 0) return () => 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 1;
  return (x) => (x - min) / (max - min);
}

/**
 * Unions FTS and semantic candidate lists by id: a candidate present in both
 * keeps the FTS `bm` and gains the semantic `cos`; FTS-only keeps `bm` (no
 * `cos`); semantic-only keeps its `cos` (and neutral `bm`).
 */
export function fuseCandidates(
  fts: MemoryCandidate[],
  semantic: MemoryCandidate[]
): MemoryCandidate[] {
  const byId = new Map<number, MemoryCandidate>();
  for (const c of fts) byId.set(c.id, { ...c });
  for (const c of semantic) {
    const existing = byId.get(c.id);
    if (existing) existing.cos = c.cos;
    else byId.set(c.id, { ...c });
  }
  return [...byId.values()];
}

/**
 * Hybrid ranking: fuses normalized BM25 (-bm) and cosine into a relevance term
 * (`α·bmNorm + (1-α)·cosNorm`), then applies the shared recency/category/
 * confidence modulator. Candidates without a `cos` contribute cosNorm 0 (rely
 * on lexical match); the lexical-leaning α keeps semantic-only candidates as
 * fill-ins behind solid keyword hits. Pure: `now` injected.
 */
export function rankHybrid(
  candidates: MemoryCandidate[],
  now: Date,
  k = 6,
  alpha = HYBRID_ALPHA
): RankedMemory[] {
  if (candidates.length === 0) return [];
  const normBm = minMaxNormalizer(candidates.map((c) => -c.bm));
  const cosValues = candidates
    .filter((c) => typeof c.cos === "number")
    .map((c) => c.cos as number);
  const normCos = minMaxNormalizer(cosValues);

  return candidates
    .map((c) => {
      const bmNorm = normBm(-c.bm);
      const cosNorm = typeof c.cos === "number" ? normCos(c.cos) : 0;
      const rel = alpha * bmNorm + (1 - alpha) * cosNorm;
      return { ...c, score: rel * scoreModulator(c, now) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
