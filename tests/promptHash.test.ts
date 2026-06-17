import { describe, it, expect } from "vitest";
import { promptHash } from "../src/prompts/hash.js";

describe("promptHash", () => {
  it("returns 12 lowercase hex characters", () => {
    expect(promptHash("hello world")).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is deterministic for the same input", () => {
    expect(promptHash("the quick brown fox")).toBe(promptHash("the quick brown fox"));
  });

  it("changes when the input changes by a single character", () => {
    expect(promptHash("instruction A")).not.toBe(promptHash("instruction B"));
  });
});
