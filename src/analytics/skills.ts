/**
 * Deterministic trigger-phrase matching for the two Atlas projection skills.
 *
 * Skills are routed BEFORE the LLM classifier: a verbatim trigger phrase is an
 * unambiguous intent, so matching it with a regex is free and never misroutes
 * (and never spends a classifier call). The matched month is spliced into the
 * skill's versioned directive (src/prompts/analytics.ts), which is layered on
 * top of the full brain to run the procedure from section 16 / 17.
 */

import type { PromptId } from "../prompts/registry.js";
import {
  OPEN_FUNNEL_SKILL_DIRECTIVE,
  M0_RFD_SKILL_DIRECTIVE,
} from "../prompts/analytics.js";

export type SkillId = "open_funnel" | "m0_rfd";

export interface SkillMatch {
  skill: SkillId;
  /** Target month as the user wrote it (e.g. "April", "April 2026"). */
  month: string;
}

interface SkillDef {
  trigger: RegExp;
  directive: string;
  promptId: PromptId;
}

// Trigger phrases are the verbatim ones documented in the brain (sections 16 &
// 17): "Run open funnel projection for [Month]" / "Run M0 assigned RFD
// projection for [Month]". Matched case-insensitively with flexible internal
// whitespace; the trailing capture is the month.
const SKILLS: Record<SkillId, SkillDef> = {
  open_funnel: {
    trigger: /run\s+open\s+funnel\s+projection\s+for\s+(.+)/i,
    directive: OPEN_FUNNEL_SKILL_DIRECTIVE,
    promptId: "analytics_skill_open_funnel",
  },
  m0_rfd: {
    trigger: /run\s+m0\s+assigned\s+rfd\s+projection\s+for\s+(.+)/i,
    directive: M0_RFD_SKILL_DIRECTIVE,
    promptId: "analytics_skill_m0_rfd",
  },
};

/** Normalize a captured month: trim and drop trailing sentence punctuation. */
function cleanMonth(raw: string): string {
  return raw.trim().replace(/[.?!,;:\s]+$/, "").trim();
}

/**
 * Returns the matched skill + month, or null when the text is not a skill
 * trigger. Skills are checked in a fixed order; their phrases don't overlap.
 */
export function matchSkill(text: string): SkillMatch | null {
  for (const skill of Object.keys(SKILLS) as SkillId[]) {
    const m = SKILLS[skill].trigger.exec(text);
    if (m && m[1]) {
      const month = cleanMonth(m[1]);
      if (month) return { skill, month };
    }
  }
  return null;
}

/** The skill's directive skeleton with {MONTH} replaced by the target month. */
export function skillDirective(skill: SkillId, month: string): string {
  return SKILLS[skill].directive.split("{MONTH}").join(month);
}

/** The versioned registry prompt id for a skill (stamped onto its reply span). */
export function skillPromptId(skill: SkillId): PromptId {
  return SKILLS[skill].promptId;
}
