import { describe, it, expect } from "vitest";
import { computeCostUsd, MODEL_PRICES } from "../src/llm/modelPricing.js";

describe("modelPricing.computeCostUsd", () => {
  it("computes gpt-4o-mini cost from input + output tokens", () => {
    // per 1K: in 0.00015, out 0.00060 → 1K in + 1K out = 0.00075
    expect(computeCostUsd("gpt-4o-mini", 1000, 1000)).toBeCloseTo(0.00075, 10);
  });

  it("computes gpt-4o cost from input + output tokens", () => {
    // per 1K: in 0.00250, out 0.01000 → 1K in + 1K out = 0.0125
    expect(computeCostUsd("gpt-4o", 1000, 1000)).toBeCloseTo(0.0125, 10);
  });

  it("prices embeddings with a zero output component", () => {
    // per 1K: in 0.00002, out 0 → output tokens never add cost
    expect(computeCostUsd("text-embedding-3-small", 1000, 0)).toBeCloseTo(0.00002, 12);
    expect(computeCostUsd("text-embedding-3-small", 1000, 9999)).toBeCloseTo(0.00002, 12);
  });

  it("returns exactly 0 for zero tokens on a known model", () => {
    expect(computeCostUsd("gpt-4o-mini", 0, 0)).toBe(0);
  });

  it("defaults missing token counts to 0", () => {
    expect(computeCostUsd("gpt-4o-mini")).toBe(0);
    expect(computeCostUsd("gpt-4o-mini", 1000)).toBeCloseTo(0.00015, 12);
  });

  it("computes gpt-5.4-mini cost (the openai-harness reply model)", () => {
    // Official OpenAI pricing: $0.75/1M input, $4.50/1M output → per 1K:
    // in 0.00075, out 0.0045 → 1K in + 1K out = 0.00525
    expect(computeCostUsd("gpt-5.4-mini", 1000, 1000)).toBeCloseTo(0.00525, 10);
    expect(computeCostUsd("gpt-5.4-mini", 1_000_000, 0)).toBeCloseTo(0.75, 6);
    expect(computeCostUsd("gpt-5.4-mini", 0, 1_000_000)).toBeCloseTo(4.5, 6);
  });

  it("returns undefined for an unknown model (never fabricates a cost)", () => {
    expect(computeCostUsd("some-future-model", 1000, 1000)).toBeUndefined();
  });

  it("exposes a price table covering the models Sentinel calls", () => {
    expect(Object.keys(MODEL_PRICES).sort()).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-5.4-mini",
      "text-embedding-3-small",
    ]);
  });
});
