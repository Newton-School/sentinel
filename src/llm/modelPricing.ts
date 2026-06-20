/**
 * Static price table for the OpenAI models Sentinel calls (extraction,
 * consolidation, embeddings). The Claude CLI already reports `total_cost_usd`
 * for the main bot, so Anthropic models are intentionally absent here — this
 * table exists to give the previously cost-blind OpenAI paths a USD figure.
 *
 * Prices are USD per 1K tokens, as of 2026-06. An unknown model yields
 * `undefined` (callers store NULL) rather than a fabricated cost.
 */

export interface ModelPrice {
  /** USD per 1K input (prompt) tokens. */
  inputPer1k: number;
  /** USD per 1K output (completion) tokens. Embeddings have no output cost. */
  outputPer1k: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gpt-4o-mini": { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  "gpt-4o": { inputPer1k: 0.0025, outputPer1k: 0.01 },
  // OpenAI Agents harness reply model. Official pricing (developers.openai.com,
  // 2026-06): $0.75/1M input, $4.50/1M output.
  "gpt-5.4-mini": { inputPer1k: 0.00075, outputPer1k: 0.0045 },
  "text-embedding-3-small": { inputPer1k: 0.00002, outputPer1k: 0 },
};

/**
 * Computes the USD cost of a call from its token counts. Returns `undefined`
 * for an unknown model so the caller can store NULL instead of a wrong number.
 */
export function computeCostUsd(
  model: string,
  inputTokens = 0,
  outputTokens = 0
): number | undefined {
  const price = MODEL_PRICES[model];
  if (!price) return undefined;
  return (inputTokens / 1000) * price.inputPer1k + (outputTokens / 1000) * price.outputPer1k;
}
