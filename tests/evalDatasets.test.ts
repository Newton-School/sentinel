import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadJsonl(name: string): Record<string, unknown>[] {
  return readFileSync(join("evals/datasets", name), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("eval golden datasets", () => {
  it("extraction.jsonl rows have the required ExtractionCase shape", () => {
    const rows = loadJsonl("extraction.jsonl");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(["conversation", "meeting", "email"]).toContain(r.sourceType);
      expect(typeof r.content).toBe("string");
      expect(Array.isArray(r.expected_facts)).toBe(true);
      for (const f of r.expected_facts as Array<Record<string, unknown>>) {
        expect(typeof f.text).toBe("string");
        expect(typeof f.category).toBe("string");
      }
    }
  });

  it("answers.jsonl rows have the required AnswerCase shape", () => {
    const rows = loadJsonl("answers.jsonl");
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.question).toBe("string");
      expect(typeof r.candidate_answer).toBe("string");
      expect(Array.isArray(r.rubric)).toBe(true);
      expect((r.rubric as unknown[]).length).toBeGreaterThan(0);
    }
  });
});
