import { describe, it, expect } from "vitest";
import { matchSkill, skillDirective, skillPromptId } from "../src/analytics/skills.js";

describe("matchSkill", () => {
  it("matches the open-funnel trigger phrase and extracts the month", () => {
    expect(matchSkill("Run open funnel projection for April")).toEqual({
      skill: "open_funnel",
      month: "April",
    });
  });

  it("matches the M0 assigned RFD trigger phrase (case-insensitive) with a year", () => {
    expect(matchSkill("run m0 assigned rfd projection for April 2026")).toEqual({
      skill: "m0_rfd",
      month: "April 2026",
    });
  });

  it("trims surrounding whitespace and trailing punctuation from the month", () => {
    expect(matchSkill("Run open funnel projection for   May  .")).toEqual({
      skill: "open_funnel",
      month: "May",
    });
  });

  it("returns null for a normal analytics question (not a skill trigger)", () => {
    expect(matchSkill("how many DS enrollments in Feb 2026?")).toBeNull();
  });

  it("returns null for a near-miss that omits the 'Run ... for' framing", () => {
    expect(matchSkill("open funnel projection April")).toBeNull();
  });

  it("does not cross-match the two skills", () => {
    expect(matchSkill("Run M0 assigned RFD projection for June")?.skill).toBe("m0_rfd");
    expect(matchSkill("Run open funnel projection for June")?.skill).toBe("open_funnel");
  });
});

describe("skillDirective", () => {
  it("splices the month into the open-funnel directive and references its section", () => {
    const d = skillDirective("open_funnel", "April");
    expect(d).toContain("April");
    expect(d).not.toContain("{MONTH}");
    expect(d.toLowerCase()).toContain("open funnel");
  });

  it("splices the month into the M0 directive (every placeholder occurrence)", () => {
    const d = skillDirective("m0_rfd", "April 2026");
    expect(d).toContain("April 2026");
    expect(d).not.toContain("{MONTH}");
  });
});

describe("skillPromptId", () => {
  it("maps each skill to its versioned registry prompt id", () => {
    expect(skillPromptId("open_funnel")).toBe("analytics_skill_open_funnel");
    expect(skillPromptId("m0_rfd")).toBe("analytics_skill_m0_rfd");
  });
});
