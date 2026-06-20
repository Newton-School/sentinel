import { describe, it, expect } from "vitest";
import { buildAnalyticsSystemPrompt, BASE_PROMPT } from "../src/agent/systemPrompt.js";
import { ANALYTICS_BRAIN } from "../src/prompts/atlas-brain.js";
import type { PersonaProfile } from "../src/persona/types.js";

const persona: PersonaProfile = {
  userId: "U1",
  displayName: "Devansh",
  role: undefined,
  createdAt: "x",
  updatedAt: "x",
};

describe("buildAnalyticsSystemPrompt", () => {
  it("uses the Atlas brain as its base (embeds it verbatim)", () => {
    const p = buildAnalyticsSystemPrompt(persona, []);
    expect(p).toContain(ANALYTICS_BRAIN);
  });

  it("carries the load-bearing brain knowledge (enrollment rule, warehouse, RFD spellings)", () => {
    const p = buildAnalyticsSystemPrompt(persona, []);
    expect(p).toContain("status = 8");
    expect(p).toContain("Altius");
    expect(p).toContain("course_user_mapping");
    // RFD has two casing variants — both must survive into the prompt.
    expect(p).toContain("Ready For Disbursal");
    expect(p).toContain("Ready for Disbursal");
  });

  it("is the analytics agent, NOT the general founders bot", () => {
    const p = buildAnalyticsSystemPrompt(persona, []);
    expect(p).not.toContain("founders-only internal intelligence assistant");
    // sanity: that phrase really is a general-prompt marker
    expect(BASE_PROMPT).toContain("founders-only internal intelligence assistant");
  });

  it("injects the current user and IST time context", () => {
    const p = buildAnalyticsSystemPrompt(persona, []);
    expect(p).toContain("Devansh");
    expect(p).toContain("IST");
  });

});
