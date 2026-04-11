import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../src/claude/systemPrompt.js";
import type { PersonaProfile, PersonaTrait } from "../src/persona/types.js";

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
  updatedAt: "2026-01-01T00:00:00Z",
};

const lowConfidenceTrait: PersonaTrait = {
  id: 2,
  userId: "U123",
  label: "focus_area",
  value: "finance",
  confidence: 0.3,
  evidenceCount: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
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

  describe("read-only behavior", () => {
    it("instructs that Sentinel is read-only", () => {
      const prompt = buildSystemPrompt(basePersona, []);
      expect(prompt).toContain("read-only");
      expect(prompt).toContain("No actions");
    });
  });
});
