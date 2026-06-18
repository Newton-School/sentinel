import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyticsCase, ExpectedRoute, Graded } from "../evals/analyticsEval.js";

const ROUTES: ExpectedRoute[] = ["analytics", "general"];
const GRADES: Graded[] = ["ground_truth", "rubric", "routing_only"];

function loadCases(): AnalyticsCase[] {
  const path = join("evals", "datasets", "analytics.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AnalyticsCase);
}

describe("analytics eval dataset", () => {
  const cases = loadCases();

  it("has at least 12 cases", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  it("has unique ids", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every case has a valid shape", () => {
    for (const c of cases) {
      expect(typeof c.id, c.id).toBe("string");
      expect(typeof c.question, c.id).toBe("string");
      expect(ROUTES, c.id).toContain(c.expectedRoute);
      expect(GRADES, c.id).toContain(c.graded);
      expect(Array.isArray(c.rubric), c.id).toBe(true);
      expect(c.rubric.length, c.id).toBeGreaterThan(0);
    }
  });

  it("ground_truth cases carry SQL; non-ground_truth cases do not", () => {
    for (const c of cases) {
      if (c.graded === "ground_truth") {
        expect(typeof c.groundTruthSql, c.id).toBe("string");
        expect(c.groundTruthSql!.length, c.id).toBeGreaterThan(0);
      } else {
        expect(c.groundTruthSql, c.id).toBeUndefined();
      }
    }
  });

  it("covers general routing negatives and the gotcha-sensitive questions", () => {
    const routes = cases.map((c) => c.expectedRoute);
    expect(routes.filter((r) => r === "general").length).toBeGreaterThanOrEqual(2);
    expect(routes.filter((r) => r === "analytics").length).toBeGreaterThanOrEqual(8);
    // at least a handful of ground-truth analytics questions
    expect(cases.filter((c) => c.graded === "ground_truth").length).toBeGreaterThanOrEqual(6);
  });
});
