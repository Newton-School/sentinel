/**
 * Generates src/prompts/atlas-brain.ts from the in-repo, reviewable source
 * markdown (src/prompts/atlas-brain.source.md).
 *
 * Why generate instead of hand-authoring the .ts: the brain doc is large and
 * dense with backticks/code fences, so a hand-escaped template literal is
 * error-prone. The source markdown stays the human-reviewable source of truth
 * (PR diffs read cleanly); this script escapes only what a JS template literal
 * interprets (\\, `, and ${) and emits the compiled-in constant. The prod image
 * ships only dist/, so the brain must be a .ts (a .md would not be shipped).
 *
 * Usage: node scripts/gen-atlas-brain.mjs   (run after editing the source .md)
 * The prompt registry hashes the result as a drift guard — if you change the
 * source, regenerate and bump the `analytics` prompt version + pinned hash in
 * tests/promptRegistry.test.ts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, "..", "src", "prompts", "atlas-brain.source.md");
const DEST = join(here, "..", "src", "prompts", "atlas-brain.ts");

const brain = readFileSync(SOURCE, "utf8").trimEnd();
const escaped = brain
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$\{/g, "\\${");

const out = `/**
 * Project Atlas — "Analytics Brain Document" for Newton School's data warehouse.
 *
 * VENDORED, verbatim domain knowledge (DB topology, status codes, lead stages,
 * SCD/MoM-funnel gotchas, query patterns, and two projection skills) sourced
 * from the shared claude.ai "Project Atlas" project (owner: Devansh), which
 * remains the authoring surface. Embedded as a string constant (not a .md
 * asset) because the prod Docker image ships only dist/.
 *
 * DO NOT hand-edit. Edit src/prompts/atlas-brain.source.md and re-run
 * scripts/gen-atlas-brain.mjs. The prompt registry hashes this as a drift guard.
 */

export const ANALYTICS_BRAIN = \`${escaped}\`;
`;

writeFileSync(DEST, out, "utf8");
console.log(`Wrote ${DEST} (${brain.length} chars, ${brain.split("\n").length} lines)`);
