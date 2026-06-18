/**
 * Prompt registry — "prompts as versioned data" (still in-repo, type-safe).
 *
 * Each prompt has an author-assigned semver `version` plus a `contentHash`
 * computed from its static skeleton. The combined `versionId`
 * ("<id>@<version>+<hash>") is stamped onto every llm_calls row, so output
 * quality (and later, eval scores + 👍/👎 feedback) can be correlated with the
 * exact prompt that produced it.
 *
 * The hash is the drift guard: a vitest pins each prompt's version + hash to a
 * committed literal, so editing a prompt's text fails the test until you bump
 * the version. See tests/promptRegistry.test.ts.
 *
 * This module imports only the static skeleton leaves (never the builders), so
 * the builders can import `activePromptVersionId` from here without a cycle.
 */

import { promptHash } from "./hash.js";
import { EXTRACTION_INSTRUCTIONS } from "./extraction.js";
import { CONSOLIDATION_SYSTEM_TEMPLATE } from "./consolidation.js";
import { BASE_PROMPT } from "../claude/systemPrompt.js";
import { ANALYTICS_BRAIN } from "./atlas-brain.js";
import { ANALYTICS_CLASSIFIER_INSTRUCTIONS } from "./analytics.js";

export type PromptId =
  | "extraction"
  | "consolidation"
  | "system"
  | "analytics"
  | "analytics_classifier";

export interface PromptDef {
  id: PromptId;
  /** Author-assigned semver; bump when you intentionally change the prompt. */
  version: string;
  /** Deterministic, clock-free string representing the versioned content. */
  skeleton: string;
  /** sha256(skeleton).slice(0,12). */
  contentHash: string;
  /** "<id>@<version>+<hash>" — what gets stamped onto llm_calls. */
  versionId: string;
}

function def(id: PromptId, version: string, skeleton: string): PromptDef {
  const contentHash = promptHash(skeleton);
  return { id, version, skeleton, contentHash, versionId: `${id}@${version}+${contentHash}` };
}

const PROMPTS: Record<PromptId, PromptDef> = {
  extraction: def("extraction", "1.0.0", EXTRACTION_INSTRUCTIONS.join("\n")),
  consolidation: def("consolidation", "1.0.0", CONSOLIDATION_SYSTEM_TEMPLATE),
  system: def("system", "1.0.0", BASE_PROMPT),
  analytics: def("analytics", "1.0.0", ANALYTICS_BRAIN),
  analytics_classifier: def("analytics_classifier", "1.1.0", ANALYTICS_CLASSIFIER_INSTRUCTIONS),
};

/** The full definition for a prompt (version, skeleton, hash, versionId). */
export function getPrompt(id: PromptId): PromptDef {
  return PROMPTS[id];
}

/** The version id stamped onto llm_calls, e.g. "extraction@1.0.0+ab12cd34ef56". */
export function activePromptVersionId(id: PromptId): string {
  return PROMPTS[id].versionId;
}
