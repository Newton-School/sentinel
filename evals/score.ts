/**
 * Deterministic scoring for the eval harness. Pure + dependency-free so it is
 * the trustworthy, non-stochastic gating signal (the LLM-as-judge in judge.ts
 * is advisory on top of this).
 *
 * Facts are matched on (category agreement + token-set text similarity); from
 * the matching we derive precision / recall / F1.
 */

export interface EvalFact {
  text: string;
  category: string;
  entities?: string[];
  subject?: string;
}

export interface FactMatchOptions {
  /** Min token-set (Jaccard) similarity of the fact texts to count as a match. */
  textThreshold?: number;
  /** Require the categories to agree (default true). */
  requireCategory?: boolean;
}

export interface PrecisionRecall {
  precision: number;
  recall: number;
  f1: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

const DEFAULT_TEXT_THRESHOLD = 0.5;

/** Lowercase, strip punctuation to spaces, collapse whitespace, trim. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s: string): Set<string> {
  const n = normalizeText(s);
  return new Set(n.length === 0 ? [] : n.split(" "));
}

/** Jaccard similarity of the two strings' token sets, in [0, 1]. */
export function tokenSetSimilarity(a: string, b: string): number {
  const sa = tokenSet(a);
  const sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** True when `actual` is a plausible match for the `expected` golden fact. */
export function factMatches(
  expected: EvalFact,
  actual: EvalFact,
  opts: FactMatchOptions = {}
): boolean {
  const requireCategory = opts.requireCategory ?? true;
  if (requireCategory && normalizeText(expected.category) !== normalizeText(actual.category)) {
    return false;
  }
  const threshold = opts.textThreshold ?? DEFAULT_TEXT_THRESHOLD;
  return tokenSetSimilarity(expected.text, actual.text) >= threshold;
}

/**
 * Greedy 1:1 matching of actual facts to expected facts, then precision/recall.
 * Each actual fact can satisfy at most one expected fact (no double-counting).
 */
export function scoreFacts(
  expected: EvalFact[],
  actual: EvalFact[],
  opts: FactMatchOptions = {}
): PrecisionRecall {
  const usedActual = new Set<number>();
  let truePositives = 0;

  for (const exp of expected) {
    for (let i = 0; i < actual.length; i++) {
      if (usedActual.has(i)) continue;
      if (factMatches(exp, actual[i], opts)) {
        usedActual.add(i);
        truePositives += 1;
        break;
      }
    }
  }

  const falsePositives = actual.length - truePositives;
  const falseNegatives = expected.length - truePositives;
  const precision = actual.length === 0 ? 1 : truePositives / actual.length;
  const recall = expected.length === 0 ? 1 : truePositives / expected.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return { precision, recall, f1, truePositives, falsePositives, falseNegatives };
}
