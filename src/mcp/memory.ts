#!/usr/bin/env node

/**
 * Memory MCP Server — explicit search/store/forget/supersede access to
 * Sentinel's persistent organizational memory store.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 *
 * Opens its OWN better-sqlite3 connection to the SQLite file owned by the
 * main Sentinel process (all SQL in src/memory/memorySql.ts is
 * db-handle-parameterized for exactly this reason). It NEVER runs migrations:
 * the main process owns the schema. When the `memories` table is absent every
 * tool returns a friendly text error instead of crashing.
 */

import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  insertFact,
  searchCandidates,
  forgetMemory,
  supersedeMemory,
  recentMemories,
  getMemoriesByIds,
} from "../memory/memorySql.js";
import {
  getEntityById,
  getEntityMemoryIds,
  getRelatedEntities,
  getTeamRoster,
  resolveQueryEntities,
  forgetEntityMemories,
  addEntityExclusion,
} from "../memory/entitySql.js";
import { rankMemories, sanitizeFtsQuery } from "../memory/rank.js";
import type { EntityRelation } from "../memory/entitySql.js";
import type { MemoryCategory, MemoryRow } from "../memory/types.js";
import { canView, viewerScopeFromEnv } from "../access/scope.js";
import { entityDigest, orgDigest } from "../memory/digest.js";
import { isEntityGraphEnabled, linkFactEntities } from "../memory/entityLink.js";
import { assertEnv } from "./requireEnv.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of opening a database at path `undefined`.
assertEnv(["SQLITE_DB_PATH"], process.env, { serverName: "memory MCP server" });

const db = new Database(process.env.SQLITE_DB_PATH!);
// Match the main process's concurrency settings (src/state/db.ts): WAL is
// idempotent (persisted in the file), and busy_timeout waits out brief
// checkpoint lock contention instead of throwing SQLITE_BUSY.
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

// Startup guard — NO migrations here: the main process owns the schema. When
// it has never run against this file, every tool reports that instead of
// crashing the server (MCP servers are spawned fresh per Claude CLI spawn, so
// a one-time startup check is sufficient).
const schemaReady =
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`)
    .get() !== undefined;

const UNINITIALIZED_MSG =
  "memory store not initialized — run the Sentinel bot once to create the schema";

// Company-brain entity graph guard (separate from `memories`): the brain tools
// degrade independently if the entity tables are absent.
const entitiesReady =
  db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entities'`)
    .get() !== undefined;

const ENTITY_UNINITIALIZED_MSG =
  "entity graph not initialized — run the Sentinel bot once to create the schema";

const CATEGORIES = [
  "decision",
  "fact",
  "owner",
  "deadline",
  "metric",
  "preference",
  "summary",
] as const;

// Index signature required by the SDK's CallToolResult type.
interface ToolText {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

function textResult(text: string): ToolText {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(payload: unknown): ToolText {
  return textResult(JSON.stringify(payload, null, 2));
}

/**
 * Wraps a tool body with the uninitialized-schema guard and a catch-all that
 * turns any thrown error into a text error message (never crash the server).
 */
function guarded(body: () => ToolText): ToolText {
  if (!schemaReady) return textResult(UNINITIALIZED_MSG);
  try {
    return body();
  } catch (err) {
    return textResult(
      `memory tool error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** As {@link guarded}, but gated on the entity-graph tables. */
function guardedEntity(body: () => ToolText): ToolText {
  if (!entitiesReady) return textResult(ENTITY_UNINITIALIZED_MSG);
  try {
    return body();
  } catch (err) {
    return textResult(
      `entity tool error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Shapes an entity's key facts (most recent active, ACL-filtered, capped). */
function entityFactsPayload(entityId: number, limit: number): Record<string, unknown>[] {
  const ids = getEntityMemoryIds(db, entityId);
  const rows = getMemoriesByIds(db, ids)
    .filter(viewerCanSee)
    .sort((a, b) => (a.assertedAt ?? a.createdAt) < (b.assertedAt ?? b.createdAt) ? 1 : -1)
    .slice(0, limit);
  return rows.map(shapeRow);
}

// The asker's scope, threaded in via the per-request MCP config env. Null when
// absent (warm-up / pre-scoped-ACL) → no ACL filtering, the pre-brain behaviour
// (safe while founders-only). In founders mode a founder viewer sees all.
const viewer = viewerScopeFromEnv(process.env);

/** ACL gate at the MCP recall edge — mirrors the in-process recallVisible. */
function viewerCanSee(m: MemoryRow): boolean {
  if (!viewer) return true;
  return canView(
    {
      visibility: m.visibility,
      subjectEntityId: m.subjectEntityId,
      scopeTeamId: m.scopeTeamId,
      sensitivity: m.sensitivity,
    },
    viewer
  );
}

function shapeRow(row: MemoryRow): Record<string, unknown> {
  return {
    id: row.id,
    text: row.text,
    category: row.category,
    sourceType: row.sourceType,
    sourceLabel: row.sourceLabel,
    assertedAt: row.assertedAt,
    createdAt: row.createdAt,
    confidence: row.confidence,
    status: row.status,
  };
}

// Raw snake_case shape for the inactive-rows query below.
interface InactiveDbRow {
  id: number;
  text: string;
  category: string;
  source_type: string;
  source_label: string | null;
  asserted_at: string | null;
  created_at: string;
  confidence: number;
  status: string;
  superseded_by: number | null;
}

const INACTIVE_FIELDS = `m.id, m.text, m.category, m.source_type, m.source_label,
   m.asserted_at, m.created_at, m.confidence, m.status, m.superseded_by`;

/**
 * Superseded/forgotten rows matching the (sanitized) query — needed so
 * forget/supersede flows can locate records that are no longer active.
 * Status-only updates don't touch the FTS index, so retired rows are still
 * MATCHable; falls back to a LIKE scan when FTS is unavailable.
 */
function searchInactive(ftsQuery: string, limit: number): Array<Record<string, unknown>> {
  if (!ftsQuery.trim()) return [];

  const shape = (r: InactiveDbRow): Record<string, unknown> => ({
    id: r.id,
    text: r.text,
    category: r.category,
    sourceType: r.source_type,
    sourceLabel: r.source_label,
    assertedAt: r.asserted_at,
    createdAt: r.created_at,
    confidence: r.confidence,
    status: r.status,
    supersededBy: r.superseded_by,
  });

  try {
    const rows = db
      .prepare(
        `SELECT ${INACTIVE_FIELDS}
         FROM memories_fts
         JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.status != 'active'
         ORDER BY bm25(memories_fts)
         LIMIT ?`
      )
      .all(ftsQuery, limit) as InactiveDbRow[];
    return rows.map(shape);
  } catch {
    // FTS unavailable — degrade to a LIKE scan over the quoted tokens.
  }

  const tokens = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (tokens.length === 0) return [];
  const conditions = tokens.map(() => `m.text LIKE ?`).join(" OR ");
  const rows = db
    .prepare(
      `SELECT ${INACTIVE_FIELDS}
       FROM memories m
       WHERE m.status != 'active' AND (${conditions})
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ?`
    )
    .all(...tokens.map((t) => `%${t}%`), limit) as InactiveDbRow[];
  return rows.map(shape);
}

const server = new McpServer({
  name: "memory",
  version: "0.1.0",
});

// Tool: search the memory store
server.tool(
  "memory_search",
  "Search Sentinel's organizational memory store (facts, decisions, owners, deadlines extracted from meetings, emails, and conversations). Use before answering \"what do you know about…\" questions, and with include_inactive=true to find record ids for forget/supersede flows.",
  {
    query: z.string().describe("Natural-language search text (e.g., 'Q3 placement target')"),
    limit: z.number().default(8).describe("Maximum results (default: 8)"),
    include_inactive: z.boolean().default(false).describe("Also list superseded/forgotten records (clearly labeled by status) — needed for forget/supersede flows"),
    include_sensitive: z.boolean().default(false).describe("Include HR/comp/legal/medical-sensitive facts (excluded by default; set true to deliberately retrieve them)"),
  },
  async ({ query, limit, include_inactive, include_sensitive }) =>
    guarded(() => {
      const ftsQuery = sanitizeFtsQuery(query);
      const candidates = searchCandidates(db, ftsQuery).filter(
        (c) => (include_sensitive || c.sensitivity !== "sensitive") && viewerCanSee(c)
      );
      const ranked = rankMemories(candidates, new Date(), limit);

      const payload: Record<string, unknown> = {
        resultCount: ranked.length,
        results: ranked.map(shapeRow),
      };
      if (include_inactive) {
        const inactive = searchInactive(ftsQuery, limit);
        payload.inactiveCount = inactive.length;
        payload.inactive = inactive;
      }
      return jsonResult(payload);
    })
);

// Tool: store a fact on explicit user request
server.tool(
  "memory_store",
  "Store a fact in Sentinel's organizational memory. Use when the user explicitly asks Sentinel to remember something.",
  {
    text: z.string().describe("The fact to remember (hard-capped at 300 chars; longer text is truncated)"),
    category: z.enum(CATEGORIES).default("fact").describe("Kind of fact (default: 'fact')"),
    entities: z.array(z.string()).optional().describe("Entity names mentioned in the fact (people, teams, companies)"),
    sensitivity: z
      .enum(["normal", "sensitive"])
      .default("normal")
      .describe("Set 'sensitive' for compensation, HR/performance, legal, or medical facts — they are then excluded from ambient recall and need explicit retrieval"),
  },
  async ({ text, category, entities, sensitivity }) =>
    guarded(() => {
      const result = insertFact(db, {
        text,
        category,
        entities,
        sourceType: "manual",
        sourceLabel: "Stored on request via Slack",
        confidence: 0.9,
        sensitivity,
      });
      // Entity-link the stored fact (parity with the in-process ingestion
      // path, which links inside memoryStore.insertFact). Best-effort: a
      // linking failure must never fail the store.
      let linked = 0;
      if (isEntityGraphEnabled()) {
        try {
          linked = linkFactEntities(db, result.id, {
            text,
            category,
            entities,
            sourceType: "manual",
          }).linked;
        } catch (err) {
          /* best-effort — entity linking must not fail a store */
          void err;
        }
      }
      return jsonResult({
        id: result.id,
        deduped: result.deduped,
        text,
        category,
        entitiesLinked: linked,
      });
    })
);

// Tool: forget a single memory by id
server.tool(
  "memory_forget",
  "Forget (soft-delete) a single memory by id. Search first, confirm with the user, then forget by id.",
  {
    id: z.number().describe("The memory id (from memory_search results)"),
  },
  async ({ id }) =>
    guarded(() => {
      const row = db
        .prepare(`SELECT text, status FROM memories WHERE id = ?`)
        .get(id) as { text: string; status: string } | undefined;
      if (!row) return textResult(`memory ${id} not found`);

      forgetMemory(db, id);
      return jsonResult({
        forgotten: true,
        id,
        text: row.text,
        previousStatus: row.status,
      });
    })
);

// Tool: bulk-forget everything from one source (redaction)
server.tool(
  "memory_forget_source",
  "Bulk-forget ALL active memories extracted from one source, by source_ref (redaction: 'forget everything from that email/meeting'). Returns the number of records forgotten.",
  {
    source_ref: z.string().describe("The source reference shared by the records (e.g., a Gmail message id or Meet conference id)"),
  },
  async ({ source_ref }) =>
    guarded(() => {
      const info = db
        .prepare(
          `UPDATE memories SET status = 'forgotten', updated_at = ?
           WHERE source_ref = ? AND status = 'active'`
        )
        .run(new Date().toISOString(), source_ref);
      return jsonResult({ sourceRef: source_ref, forgottenCount: info.changes });
    })
);

// Tool: replace an outdated memory
server.tool(
  "memory_supersede",
  "Replace an outdated memory with corrected text: stores the new fact and marks the old record superseded, keeping the replacement chain. Search first, confirm the exact record with the user, then supersede by id.",
  {
    old_id: z.number().describe("Id of the outdated memory (from memory_search results)"),
    new_text: z.string().describe("The corrected fact text"),
    category: z.enum(CATEGORIES).optional().describe("Category for the new fact (defaults to the old record's category)"),
  },
  async ({ old_id, new_text, category }) =>
    guarded(() => {
      const old = db
        .prepare(`SELECT text, category FROM memories WHERE id = ?`)
        .get(old_id) as { text: string; category: MemoryCategory } | undefined;
      if (!old) return textResult(`memory ${old_id} not found`);

      const result = supersedeMemory(db, old_id, {
        text: new_text,
        category: category ?? old.category,
        sourceType: "manual",
        sourceLabel: "Superseded on request via Slack",
        confidence: 0.9,
        // The correction is being asserted now, so it can never be refused as
        // staler than the record it replaces.
        assertedAt: new Date().toISOString(),
      });
      return jsonResult({
        oldId: old_id,
        oldText: old.text,
        newId: result.id,
        newText: new_text,
        // insertFact may dedup the "new" text onto the old row itself, in
        // which case nothing was superseded.
        superseded: result.id !== old_id,
      });
    })
);

// Tool: list the newest active facts
server.tool(
  "memory_recent",
  "List the most recently stored active memories, newest first.",
  {
    limit: z.number().default(10).describe("Maximum results (default: 10)"),
  },
  async ({ limit }) =>
    guarded(() => {
      const rows = recentMemories(db, limit);
      return jsonResult({
        resultCount: rows.length,
        results: rows.map(shapeRow),
      });
    })
);

// --- Company brain: entity-graph tools --------------------------------------

// Tool: find entities (people/teams/projects) by name
server.tool(
  "entity_search",
  "Search the company-brain entity graph for people, teams, projects, etc. mentioned by name. Returns matching entities with their type and how many facts are linked. Use before entity_get / org_lookup to find an entity_id.",
  {
    query: z.string().describe("Name or phrase to look up (e.g., 'placements team', 'Rahul')"),
    limit: z.number().default(8).describe("Maximum results (default: 8)"),
  },
  async ({ query, limit }) =>
    guardedEntity(() => {
      const mentioned = resolveQueryEntities(db, query, limit);
      return jsonResult({
        resultCount: mentioned.length,
        results: mentioned.map((m) => ({
          entityId: m.entityId,
          name: m.name,
          type: m.type,
          factCount: getEntityMemoryIds(db, m.entityId).length,
        })),
      });
    })
);

// Tool: full dossier-style view of one entity
server.tool(
  "entity_get",
  "Get a company-brain entity by id: its name/type plus its most recent linked facts. Use to answer \"what do we know about <person/team>\".",
  {
    entity_id: z.number().describe("Entity id (from entity_search)"),
    fact_limit: z.number().default(10).describe("Max linked facts to include (default: 10)"),
  },
  async ({ entity_id, fact_limit }) =>
    guardedEntity(() => {
      const e = getEntityById(db, entity_id);
      if (!e || e.status !== "active") return textResult(`entity ${entity_id} not found`);
      return jsonResult({
        entityId: e.id,
        name: e.canonicalName,
        type: e.type,
        aliases: e.aliases,
        keyFacts: entityFactsPayload(e.id, fact_limit),
      });
    })
);

// Tool: facts linked to an entity
server.tool(
  "entity_facts",
  "List the facts linked to a company-brain entity (most recent first).",
  {
    entity_id: z.number().describe("Entity id (from entity_search)"),
    limit: z.number().default(10).describe("Maximum facts (default: 10)"),
  },
  async ({ entity_id, limit }) =>
    guardedEntity(() => {
      const facts = entityFactsPayload(entity_id, limit);
      return jsonResult({ entityId: entity_id, resultCount: facts.length, results: facts });
    })
);

// Tool: team roster (lead + members) from the edge graph
server.tool(
  "team_roster",
  "Get a team's lead (manages) and members (member_of) from the company-brain org graph. Pass a team entity_id (from entity_search).",
  {
    team_id: z.number().describe("Team entity id (from entity_search)"),
  },
  async ({ team_id }) =>
    guardedEntity(() => {
      const team = getEntityById(db, team_id);
      if (!team || team.status !== "active") return textResult(`team ${team_id} not found`);
      const roster = getTeamRoster(db, team_id);
      return jsonResult({ team: { entityId: team.id, name: team.canonicalName }, ...roster });
    })
);

// Tool: follow an org-graph relation (owns / manages / reports_to / ...)
server.tool(
  "org_lookup",
  "Follow a relation in the company-brain org graph from an entity: e.g. what a person/team 'owns' or 'manages'. Edges are confidence-weighted and decay if not reinforced; low-confidence/stale edges are omitted.",
  {
    entity_id: z.number().describe("Source entity id (from entity_search)"),
    relation: z
      .enum(["owns", "manages", "reports_to", "member_of", "works_on", "depends_on", "part_of", "related_to"])
      .describe("Relation to follow from the source entity"),
  },
  async ({ entity_id, relation }) =>
    guardedEntity(() => {
      const related = getRelatedEntities(db, entity_id, relation as EntityRelation);
      return jsonResult({
        entityId: entity_id,
        relation,
        resultCount: related.length,
        results: related.map((r) => ({
          entityId: r.entityId,
          name: r.name,
          type: r.type,
          confidence: Number(r.confidence.toFixed(2)),
        })),
      });
    })
);

// Tool: "what changed about this entity recently"
server.tool(
  "entity_digest",
  "Summarize what changed about a person/team recently — the facts linked to the entity within the last N days (newest first). Use for \"what's new with <entity> this week\". Excludes sensitive facts.",
  {
    entity_id: z.number().describe("Entity id (from entity_search)"),
    days: z.number().default(7).describe("Look-back window in days (default: 7)"),
  },
  async ({ entity_id, days }) =>
    guardedEntity(() => {
      const d = entityDigest(db, entity_id, Date.now() - days * DAY_MS, viewer ?? undefined);
      if (!d) return textResult(`entity ${entity_id} not found`);
      return jsonResult(d);
    })
);

// Tool: "what changed across the org recently"
server.tool(
  "org_digest",
  "Summarize what changed across the whole org recently — active facts created within the last N days (newest first), annotated with their subject entity. Use for \"what's new this week\". Excludes sensitive facts.",
  {
    days: z.number().default(7).describe("Look-back window in days (default: 7)"),
    limit: z.number().default(30).describe("Maximum facts (default: 30)"),
  },
  async ({ days, limit }) =>
    guardedEntity(() => jsonResult(orgDigest(db, Date.now() - days * DAY_MS, viewer ?? undefined, limit)))
);

// Tool: right-to-be-forgotten for an entity
server.tool(
  "memory_forget_entity",
  "Forget everything about a person/team and stop storing new facts about them (right-to-be-forgotten): redacts all active memories whose subject is this entity AND adds it to the do-not-store exclusion list. Find the entity_id via entity_search first; confirm with the user before calling.",
  {
    entity_id: z.number().describe("Entity id (from entity_search)"),
    reason: z.string().optional().describe("Optional note for the audit trail (e.g., 'left the company')"),
  },
  async ({ entity_id, reason }) =>
    guardedEntity(() => {
      const e = getEntityById(db, entity_id);
      if (!e) return textResult(`entity ${entity_id} not found`);
      const forgottenCount = forgetEntityMemories(db, entity_id);
      addEntityExclusion(db, entity_id, reason, "mcp");
      return jsonResult({ entityId: entity_id, name: e.canonicalName, forgottenCount, excluded: true });
    })
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Memory MCP server fatal error:", err);
  process.exit(1);
});
