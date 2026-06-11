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
 * Ranks search candidates with a composite score and returns the top `k`.
 *
 *   rel      = -bm                      (SQLite bm25: lower/more negative = better)
 *   recency  = 0.5 ^ (ageDays / 90)     (from updated_at; malformed/future = fresh)
 *   catBoost = 1.25 for decision|owner|deadline, else 1.0
 *   score    = rel × (0.5 + 0.5·recency) × catBoost × (0.5 + 0.5·confidence)
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
    .map((c) => {
      const rel = -c.bm;

      const updatedMs = new Date(c.updatedAt).getTime();
      let ageDays = (now.getTime() - updatedMs) / DAY_MS;
      // Malformed or future timestamps must not zero out a memory: treat as fresh.
      if (Number.isNaN(ageDays) || ageDays < 0) ageDays = 0;
      const recency = Math.pow(0.5, ageDays / MEMORY_RECENCY_HALF_LIFE_DAYS);

      const catBoost = BOOSTED_CATEGORIES.has(c.category) ? CATEGORY_BOOST : 1.0;
      const score =
        rel * (0.5 + 0.5 * recency) * catBoost * (0.5 + 0.5 * c.confidence);

      return { ...c, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
