import { describe, it, expect, vi } from "vitest";

// Mock config module to prevent process.exit on missing env vars
vi.mock("../src/config.js", () => ({
  config: {
    SQLITE_DB_PATH: ":memory:",
    LOG_LEVEL: "silent",
  },
}));

// Mock pino to avoid logger noise
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

import { categorizeQuery } from "../src/persona/tracker.js";

describe("categorizeQuery", () => {
  it("categorizes placements queries", () => {
    expect(categorizeQuery("What's happening with placements?")).toBe("placements");
    expect(categorizeQuery("Show me employer activity this week")).toBe("placements");
    expect(categorizeQuery("Any candidate rejections recently?")).toBe("placements");
  });

  it("categorizes admissions queries", () => {
    expect(categorizeQuery("What's the admissions funnel looking like?")).toBe("admissions");
    expect(categorizeQuery("Show me enrollment numbers")).toBe("admissions");
    expect(categorizeQuery("How are counselor conversions?")).toBe("admissions");
  });

  it("categorizes student health queries", () => {
    expect(categorizeQuery("Any student support escalations?")).toBe("student_health");
    expect(categorizeQuery("What's the dropout risk and student sentiment?")).toBe("student_health");
    expect(categorizeQuery("Show me student complaint trends")).toBe("student_health");
  });

  it("categorizes product execution queries", () => {
    expect(categorizeQuery("Show me open PRs on newton-web")).toBe("product_execution");
    expect(categorizeQuery("How many deploys this week?")).toBe("product_execution");
    expect(categorizeQuery("What's on the product roadmap?")).toBe("product_execution");
  });

  it("categorizes finance queries", () => {
    expect(categorizeQuery("What were our revenue numbers last month?")).toBe("finance");
    expect(categorizeQuery("Show me MRR trends")).toBe("finance");
    expect(categorizeQuery("What's the current budget spend?")).toBe("finance");
  });

  it("categorizes NST operations queries", () => {
    expect(categorizeQuery("What's happening with NST campus operations?")).toBe("nst_operations");
    expect(categorizeQuery("How's the internship readiness?")).toBe("nst_operations");
  });

  it("defaults to general for ambiguous queries", () => {
    expect(categorizeQuery("give me an update")).toBe("general");
    expect(categorizeQuery("what's new?")).toBe("general");
    expect(categorizeQuery("hello")).toBe("general");
  });

  it("picks the category with more keyword matches", () => {
    expect(
      categorizeQuery(
        "What's our revenue, MRR, and churn rate compared to sales targets and budget?"
      )
    ).toBe("finance");
  });
});
