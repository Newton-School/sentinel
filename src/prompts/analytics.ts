/**
 * Hand-authored, versioned prompts for the analytics route — kept separate from
 * the large vendored brain (atlas-brain.ts) so they stay readable and diffable.
 *
 * - ANALYTICS_CLASSIFIER_INSTRUCTIONS steers the cheap intent classifier
 *   (src/analytics/classifier.ts) that routes a Slack message to the analytics
 *   agent vs the general bot.
 * - The *_SKILL_DIRECTIVE templates are the static skeletons layered ON TOP of
 *   the brain for the two trigger-phrase projection skills. The runtime month is
 *   spliced in via {MONTH} (mirrors consolidation's {ENTITY}), so the versioned
 *   skeleton is stable across calls.
 *
 * All four are registered + hash-pinned in src/prompts/registry.ts.
 */

/** Static instruction block for the analytics-vs-general intent classifier. */
export const ANALYTICS_CLASSIFIER_INSTRUCTIONS = `You are an intent router for Sentinel, an internal Slack assistant for Newton School.

Classify the user's message into one of two intents:

- "analytics": the message asks for a number, metric, trend, breakdown, or list that must be answered from Newton School's data warehouse (Metabase / Altius). Signals: enrollments, leads, funnel, conversions, RFD, revenue, collections, cohorts, BDE/sales performance, calls/connects, test/session counts, ICP/grade, churn, watchtime/attendance, dashboards, "how many", "what's the trend", "run SQL", or any request naming the projection skills ("open funnel projection", "M0 assigned RFD projection").
- "general": everything else — questions about code/PRs, meetings/transcripts, emails, calendars, Notion docs, people/teams, casual chat, or remembering/forgetting facts.

Be conservative: choose "analytics" ONLY when answering clearly requires querying the data warehouse. If the message is ambiguous, a greeting, or a non-data question, choose "general".

Return a confidence in [0,1] reflecting how sure you are of the chosen intent.`;

/**
 * Skill skeleton for "Run open funnel projection for [Month]" (brain section
 * 16). Layered on top of the full brain; {MONTH} is replaced at runtime.
 */
export const OPEN_FUNNEL_SKILL_DIRECTIVE = `## Skill invocation — Open Funnel RFD Projection

The user invoked the OPEN FUNNEL RFD PROJECTION skill (section 16 above) for the target month: {MONTH}.

Execute that section's procedure autonomously — do NOT ask clarifying questions. Pull the historical base (complete months from Jan 2026), pull the open-funnel snapshot for {MONTH}, compute best/average/worst per-stage scenarios, and present the output EXACTLY as section 16 specifies (summary cards + full stage table). Run all SQL against Altius via the metabase tools; never fabricate numbers — if a query fails or returns nothing, say so.`;

/**
 * Skill skeleton for "Run M0 assigned RFD projection for [Month]" (brain
 * section 17). Layered on top of the full brain; {MONTH} is replaced at runtime.
 */
export const M0_RFD_SKILL_DIRECTIVE = `## Skill invocation — M0 Assigned RFD Projection

The user invoked the M0 ASSIGNED RFD PROJECTION skill (section 17 above) for the target month: {MONTH}.

Execute that section's procedure autonomously — do NOT ask clarifying questions. Use Dashboard 485, Tab 198 ("Funnel"). Pull the historical cards, compute per-cohort best/average/worst scenarios (rate base = Jan 2026 onwards), apply rates to expected {MONTH} volume, and present the output EXACTLY as section 17 specifies (summary cards, per-card historical tables, combined M0 + M-N total). Run all SQL against Altius via the metabase tools; never fabricate numbers — if a query fails or returns nothing, say so.`;
