import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/claude/systemPrompt.js";
import type { PersonaProfile, PersonaTrait } from "../src/persona/types.js";

// A recent timestamp so traits are not faded out by the read-time decay
// applied inside buildSystemPrompt (decay is keyed off `updatedAt`).
const NOW_ISO = new Date().toISOString();
// A deliberately stale timestamp (~6 months old) used to exercise decay.
const STALE_ISO = new Date(
  Date.now() - 180 * 24 * 60 * 60 * 1000
).toISOString();

const basePersona: PersonaProfile = {
  userId: "U123",
  displayName: "Dipesh",
  role: "Founder",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const noRolePersona: PersonaProfile = {
  ...basePersona,
  role: null,
};

const highConfidenceTrait: PersonaTrait = {
  id: 1,
  userId: "U123",
  label: "focus_area",
  value: "placements",
  confidence: 0.8,
  evidenceCount: 5,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: NOW_ISO,
};

const lowConfidenceTrait: PersonaTrait = {
  id: 2,
  userId: "U123",
  label: "focus_area",
  value: "finance",
  confidence: 0.3,
  evidenceCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: NOW_ISO,
};

describe("buildSystemPrompt", () => {
  describe("response format sections", () => {
    it("contains all 5 required response sections", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("**Answer**");
      expect(prompt).toContain("**Why this answer**");
      expect(prompt).toContain("**Evidence checked**");
      expect(prompt).toContain("**Confidence**");
      expect(prompt).toContain("**Unknowns**");
    });

    it("contains confidence level definitions", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("High");
      expect(prompt).toContain("Medium");
      expect(prompt).toContain("Low");
    });

    it("instructs to never skip sections", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("ALWAYS structure every response using these five sections");
    });
  });

  describe("evidence grounding", () => {
    it("instructs to cite sources", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Cite your sources");
    });

    it("instructs to never fabricate data", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Never fabricate data");
    });

    it("instructs to surface conflicts", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Surface conflicts");
    });

    it("includes Slack mrkdwn formatting rules", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Slack mrkdwn");
      expect(prompt).toContain("single asterisks, NOT double");
      expect(prompt).toContain("No horizontal rules");
    });
  });

  describe("source transparency", () => {
    it("instructs to state which sources were NOT checked", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("which sources you did NOT check");
    });

    it("lists all available data sources", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Metabase");
      expect(prompt).toContain("GitHub");
      expect(prompt).toContain("Slack");
      expect(prompt).toContain("Gmail");
      expect(prompt).toContain("Google Calendar");
      expect(prompt).toContain("Meeting Transcripts");
      expect(prompt).toContain("Notion");
    });
  });

  describe("time awareness", () => {
    it("injects current time context with IST timezone", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("## Current Time");
      expect(prompt).toContain("(IST)");
      expect(prompt).toContain("Today is");
      expect(prompt).toContain("This week:");
    });

    it("instructs to resolve relative dates", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("resolve them to exact dates in IST timezone");
    });

    it("instructs to prefer recent data", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("prefer recent data");
    });
  });

  describe("Newton School domain context", () => {
    it("contains all 6 domain categories", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("**Placements**");
      expect(prompt).toContain("**Admissions**");
      expect(prompt).toContain("**Student Health**");
      expect(prompt).toContain("**Product Execution**");
      expect(prompt).toContain("**Finance**");
      expect(prompt).toContain("**NST Operations**");
    });

    it("maps each domain to relevant data sources", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      // Placements should check Metabase, Slack, Gmail, transcripts
      expect(prompt).toMatch(/Placements.*Check:.*Metabase/s);
      // Product Execution should check GitHub
      expect(prompt).toMatch(/Product Execution.*Check:.*GitHub/s);
    });
  });

  describe("unavailable sources", () => {
    it("includes warning when sources are unavailable", () => {
      const prompt = buildSystemPrompt(basePersona, [], ["Gmail", "Google Calendar"]);
      expect(prompt).toContain("## Source Availability Warning");
      expect(prompt).toContain("Gmail, Google Calendar");
      expect(prompt).toContain("currently unavailable");
    });

    it("does not include warning when all sources are available", () => {
      const prompt = buildSystemPrompt(basePersona, [], []);
      expect(prompt).not.toContain("Source Availability Warning");
    });

    it("does not include warning when unavailableSources is undefined", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).not.toContain("Source Availability Warning");
    });
  });

  describe("persona context", () => {
    it("includes user display name", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("**Dipesh**");
    });

    it("includes user role when set", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("Founder");
    });

    it("omits role when null", () => {
      const prompt = buildSystemPrompt(noRolePersona, []);
      expect(prompt).not.toContain("Their role is:");
    });
  });

  describe("trait-based personalization", () => {
    it("includes high-confidence traits", () => {
      const prompt = buildSystemPrompt(basePersona, [highConfidenceTrait]);
      expect(prompt).toContain("## User Preferences");
      expect(prompt).toContain("focus_area");
      expect(prompt).toContain("placements");
      expect(prompt).toContain("80%");
      expect(prompt).toContain("5 queries");
    });

    it("excludes low-confidence traits", () => {
      const prompt = buildSystemPrompt(basePersona, [lowConfidenceTrait]);
      expect(prompt).not.toContain("## User Preferences");
      expect(prompt).not.toContain("finance");
    });

    it("includes instruction to weight open-ended queries", () => {
      const prompt = buildSystemPrompt(basePersona, [highConfidenceTrait]);
      expect(prompt).toContain("Weight your responses toward these areas");
    });
  });

  describe("trait cap + read-time decay", () => {
    function makeTrait(
      id: number,
      value: string,
      confidence: number,
      updatedAt: string
    ): PersonaTrait {
      return {
        id,
        userId: "U123",
        label: "focus_area",
        value,
        confidence,
        evidenceCount: id,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt,
      };
    }

    it("caps the rendered preferences at the top 8 by confidence", () => {
      // 12 fresh qualifying traits with distinct, descending confidences.
      const traits: PersonaTrait[] = [];
      for (let i = 0; i < 12; i++) {
        // confidences 0.94, 0.91, ... all >= 0.6
        traits.push(makeTrait(i + 1, `area_${i}`, 0.94 - i * 0.03, NOW_ISO));
      }

      const prompt = buildSystemPrompt(basePersona, traits);
      const lines = prompt
        .split("\n")
        .filter((l) => l.startsWith("- **focus_area**"));

      // Only the top 8 are rendered.
      expect(lines).toHaveLength(8);
      // The 8 highest-confidence areas (area_0..area_7) are present.
      for (let i = 0; i < 8; i++) {
        expect(prompt).toContain(`area_${i}`);
      }
      // The 4 lowest-confidence areas are dropped.
      for (let i = 8; i < 12; i++) {
        expect(prompt).not.toContain(`area_${i}`);
      }
    });

    it("renders capped traits in descending confidence order", () => {
      const traits: PersonaTrait[] = [
        makeTrait(1, "low_keep", 0.62, NOW_ISO),
        makeTrait(2, "high", 0.9, NOW_ISO),
        makeTrait(3, "mid", 0.75, NOW_ISO),
      ];
      const prompt = buildSystemPrompt(basePersona, traits);
      expect(prompt.indexOf("high")).toBeLessThan(prompt.indexOf("mid"));
      expect(prompt.indexOf("mid")).toBeLessThan(prompt.indexOf("low_keep"));
    });

    it("excludes a trait that decays below 0.6 even though its stored value is >= 0.6", () => {
      // Stored 0.8 but very stale -> decays well under 0.6.
      const stale = makeTrait(1, "placements", 0.8, STALE_ISO);
      const prompt = buildSystemPrompt(basePersona, [stale]);
      expect(prompt).not.toContain("## User Preferences");
      expect(prompt).not.toContain("placements");
    });

    it("keeps a fresh trait while dropping a stale one of equal stored confidence", () => {
      const fresh = makeTrait(1, "fresh_area", 0.8, NOW_ISO);
      const stale = makeTrait(2, "stale_area", 0.8, STALE_ISO);
      const prompt = buildSystemPrompt(basePersona, [fresh, stale]);
      expect(prompt).toContain("fresh_area");
      expect(prompt).not.toContain("stale_area");
    });
  });

  describe("read-only behavior", () => {
    it("instructs that Sentinel is read-only", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("read-only");
      expect(prompt).toContain("No actions");
    });
  });
});
