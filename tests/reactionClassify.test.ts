import { describe, it, expect, vi } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

import { classifyReaction } from "../src/feedback/reactions.js";

describe("classifyReaction", () => {
  it("maps thumbs up / check marks to positive", () => {
    expect(classifyReaction("+1")).toBe("positive");
    expect(classifyReaction("thumbsup")).toBe("positive");
    expect(classifyReaction("white_check_mark")).toBe("positive");
  });

  it("maps thumbs down to negative", () => {
    expect(classifyReaction("-1")).toBe("negative");
    expect(classifyReaction("thumbsdown")).toBe("negative");
  });

  it("ignores skin-tone suffixes", () => {
    expect(classifyReaction("thumbsup::skin-tone-3")).toBe("positive");
    expect(classifyReaction("-1::skin-tone-5")).toBe("negative");
  });

  it("returns null for unrelated reactions", () => {
    expect(classifyReaction("eyes")).toBeNull();
    expect(classifyReaction("tada")).toBeNull();
    expect(classifyReaction("")).toBeNull();
  });
});
