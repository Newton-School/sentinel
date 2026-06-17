import { describe, it, expect, vi } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});
vi.mock("../src/config.js", () => ({
  config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
}));

import { getPrompt, activePromptVersionId } from "../src/prompts/registry.js";
import { EXTRACTION_INSTRUCTIONS } from "../src/prompts/extraction.js";
import { CONSOLIDATION_SYSTEM_TEMPLATE, consolidationSystem } from "../src/prompts/consolidation.js";
import { BASE_PROMPT, buildSystemPrompt, buildAnalyticsSystemPrompt } from "../src/claude/systemPrompt.js";
import { ANALYTICS_BRAIN } from "../src/prompts/atlas-brain.js";
import { buildExtractionSystemPrompt } from "../src/memory/extractor.js";
import { buildConsolidationPrompt } from "../src/memory/consolidate.js";

// Committed version + content-hash pins. THIS IS THE "EDIT A PROMPT ⇒ BUMP ITS
// VERSION" GATE: if a test below fails because you intentionally changed a
// prompt's text, bump its `version` in src/prompts/registry.ts AND update the
// hash here. If it failed and you did NOT mean to change the prompt, your edit
// touched versioned instruction text — revert it.
const PINNED = {
  extraction: { version: "1.0.0", hash: "7d9323b8ba5a" },
  consolidation: { version: "1.0.0", hash: "4f47602a149a" },
  system: { version: "1.0.0", hash: "89c11ce42da9" },
  analytics: { version: "1.0.0", hash: "96f694187d76" },
  analytics_classifier: { version: "1.0.0", hash: "05b484f078c2" },
  analytics_skill_open_funnel: { version: "1.0.0", hash: "2e93eb304abe" },
  analytics_skill_m0_rfd: { version: "1.0.0", hash: "771cac051d7c" },
} as const;

describe("prompt registry — drift gate", () => {
  for (const id of [
    "extraction",
    "consolidation",
    "system",
    "analytics",
    "analytics_classifier",
    "analytics_skill_open_funnel",
    "analytics_skill_m0_rfd",
  ] as const) {
    it(`${id} version + content hash are pinned`, () => {
      const p = getPrompt(id);
      expect(p.version).toBe(PINNED[id].version);
      expect(p.contentHash).toBe(PINNED[id].hash);
      expect(p.contentHash).toMatch(/^[0-9a-f]{12}$/);
      expect(p.versionId).toBe(`${id}@${PINNED[id].version}+${PINNED[id].hash}`);
      expect(activePromptVersionId(id)).toBe(p.versionId);
    });
  }
});

describe("prompt registry — skeleton ↔ builder parity", () => {
  it("extraction skeleton is the static block, embedded verbatim in the built prompt", () => {
    expect(getPrompt("extraction").skeleton).toBe(EXTRACTION_INSTRUCTIONS.join("\n"));
    const built = buildExtractionSystemPrompt({ sourceType: "conversation", sourceLabel: "L" });
    expect(built).toContain(EXTRACTION_INSTRUCTIONS.join("\n"));
  });

  it("consolidation skeleton is the template, and the builder renders it for an entity", () => {
    expect(getPrompt("consolidation").skeleton).toBe(CONSOLIDATION_SYSTEM_TEMPLATE);
    expect(buildConsolidationPrompt("Acme", []).system).toBe(consolidationSystem("Acme"));
    expect(buildConsolidationPrompt("Acme", []).system).toContain('about "Acme"');
    expect(getPrompt("consolidation").skeleton).toContain("{ENTITY}");
  });

  it("system skeleton is BASE_PROMPT, embedded in the built system prompt", () => {
    expect(getPrompt("system").skeleton).toBe(BASE_PROMPT);
    const persona = { userId: "U", displayName: "Dipesh", role: undefined, createdAt: "x", updatedAt: "x" };
    const built = buildSystemPrompt(persona as never, []);
    expect(built).toContain(BASE_PROMPT);
  });

  it("analytics skeleton is ANALYTICS_BRAIN, embedded in the built analytics prompt", () => {
    expect(getPrompt("analytics").skeleton).toBe(ANALYTICS_BRAIN);
    const persona = { userId: "U", displayName: "Dipesh", role: undefined, createdAt: "x", updatedAt: "x" };
    const built = buildAnalyticsSystemPrompt(persona as never, []);
    expect(built).toContain(ANALYTICS_BRAIN);
  });
});
