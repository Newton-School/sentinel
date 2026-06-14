#!/usr/bin/env node

/**
 * One-off smoke harness for the company-brain entity pipeline. Exercises the
 * REAL code path against a file-backed SQLite DB with MEMORY_ENTITY_GRAPH on:
 * insertFact → linkFactEntities → org-edge inference → backfill →
 * assembleRetrieval → buildSystemPrompt. Prints the graph + the injected
 * memory section. Not part of the running app.
 *
 * Usage: SQLITE_DB_PATH=/tmp/sentinel-verify.db MEMORY_ENTITY_GRAPH=1 \
 *        npx tsx scripts/verify-entity-brain.ts
 */

import { getDb, closeDb } from "../src/state/db.js";
import {
  insertFact,
  assembleRetrieval,
  currentViewerScope,
} from "../src/memory/memoryStore.js";
import { backfillEntityLinks } from "../src/memory/entityLink.js";
import { buildSystemPrompt } from "../src/claude/systemPrompt.js";
import {
  getRelatedEntities,
  getTeamRoster,
  resolveQueryEntities,
} from "../src/memory/entitySql.js";
import type { MemoryCategory } from "../src/memory/types.js";

process.env.MEMORY_ENTITY_GRAPH = "1";

const db = getDb();

const facts: Array<{ text: string; category: MemoryCategory; entities: string[] }> = [
  { text: "Rahul Sharma owns the placements team and its Q3 employer pipeline", category: "owner", entities: ["Rahul Sharma", "Placements team"] },
  { text: "Rahul Sharma decided to raise the CTC target to 14 LPA for Q3", category: "decision", entities: ["Rahul Sharma"] },
  { text: "Rahul Sharma owns the placements team end-to-end this quarter", category: "owner", entities: ["Rahul Sharma", "Placements team"] },
  { text: "Priya Nair owns the admissions funnel revamp project", category: "owner", entities: ["Priya Nair", "Admissions Funnel Revamp"] },
  { text: "Placements team closed 50 offers in May", category: "metric", entities: ["Placements team"] },
];
for (const f of facts) insertFact({ ...f, sourceType: "manual" });

console.log("== backfill ==", backfillEntityLinks(db));

console.log("\n== entities ==");
console.log(db.prepare("SELECT id, type, canonical_name FROM entities ORDER BY id").all());

console.log("\n== edges ==");
console.log(
  db.prepare("SELECT src_id, dst_id, relation, ROUND(confidence,3) AS conf, evidence_count FROM entity_edges").all()
);

const rahul = db.prepare("SELECT id FROM entities WHERE canonical_name='Rahul Sharma'").get() as
  | { id: number }
  | undefined;
if (rahul) {
  console.log("\n== Rahul manages ==", getRelatedEntities(db, rahul.id, "manages"));
}
const team = db.prepare("SELECT id FROM entities WHERE canonical_name='Placements team'").get() as
  | { id: number }
  | undefined;
if (team) {
  console.log("== Placements roster ==", getTeamRoster(db, team.id));
}

console.log("\n== resolveQueryEntities('placements team') ==");
console.log(resolveQueryEntities(db, "what is the placements team doing", 3));

const viewer = currentViewerScope("U1");
const bundle = assembleRetrieval("what is the placements team working on", "U1", viewer);
console.log("\n== retrieval bundle ==");
console.log(JSON.stringify(
  {
    queryFacts: bundle.queryFacts.map((f) => f.text),
    entityFacts: bundle.entityFacts.map((f) => f.text),
    dossiers: bundle.dossiers.map((d) => d.name),
    mentioned: bundle.mentionedEntities,
  },
  null,
  2
));

const prompt = buildSystemPrompt(
  { userId: "U1", displayName: "Dipesh", role: null, createdAt: "", updatedAt: "" },
  [],
  [],
  undefined,
  bundle
);
const idx = prompt.indexOf("## Organizational memory");
console.log("\n== injected memory section ==\n" + (idx >= 0 ? prompt.slice(idx) : "(none injected)"));

closeDb();
