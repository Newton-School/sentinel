#!/usr/bin/env node

/**
 * Memory MCP Server — explicit search/store/forget/supersede access to
 * Sentinel's persistent organizational memory store.
 * Runs as a stdio-based MCP server, spawned by the agent harness over stdio MCP.
 *
 * Opens its OWN pg Pool to the Postgres database owned by the main Sentinel
 * process (all SQL in src/memory/memorySql.ts is `Queryable`-parameterized for
 * exactly this reason). It NEVER runs migrations: the main process owns the
 * schema. When the `memories` table is absent every tool returns a friendly
 * text error instead of crashing. It does NOT call getPool()/initDb() — that is
 * the main app's singleton; this subprocess binds its own pool to the same DB.
 */

import pg from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isFtsAvailable, type Queryable } from "../state/db.js";
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
import { isEntityGraphEnabled, linkFactEntities, retractFactEdges } from "../memory/entityLink.js";
import { assertEnv } from "./requireEnv.js";

const { Pool } = pg;

const DAY_MS = 24 * 60 * 60 * 1000;

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of opening a database against `undefined`.
assertEnv(["DATABASE_URL"], process.env, { serverName: "memory MCP server" });

// Open this subprocess's OWN pool (NOT the main app's getPool() singleton). The
// main process owns the schema/migrations — we only read/write against it.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// A pool 'error' on an idle client must never crash the server process.
pool.on("error", (err) => {
  console.error("memory MCP idle pg client error (non-fatal):", err);
});

// Startup guards — NO migrations here: the main process owns the schema. When
// it has never run against this database, every tool reports that instead of
// crashing the server. These are populated once in main() before the server
// accepts requests (MCP servers are spawned fresh per request, so a one-time
// startup check is sufficient).
let schemaReady = false;
let entitiesReady = false;

const UNINITIALIZED_MSG =
  "memory store not initialized — run the Sentinel bot once to create the schema";

const ENTITY_UNINITIALIZED_MSG =
  "entity graph not initialized — run the Sentinel bot once to create the schema";

/** True when `table` exists in the current database. */
async function tableExists(q: Queryable, table: string): Promise<boolean> {
  const row = (await q.query(`SELECT to_regclass($1) AS reg`, [table])).rows[0] as
    | { reg: string | null }
    | undefined;
  return row?.reg != null;
}

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
async function guarded(body: () => Promise<ToolText>): Promise<ToolText> {
  if (!schemaReady) return textResult(UNINITIALIZED_MSG);
  try {
    return await body();
  } catch (err) {
    return textResult(
      `memory tool error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** As {@link guarded}, but gated on the entity-graph tables. */
async function guardedEntity(body: () => Promise<ToolText>): Promise<ToolText> {
  if (!entitiesReady) return textResult(ENTITY_UNINITIALIZED_MSG);
  try {
    return await body();
  } catch (err) {
    return textResult(
      `entity tool error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Shapes an entity's key facts (most recent active, ACL-filtered, capped).
 * Sensitive facts (HR/comp/legal/medical) are excluded unless
 * `includeSensitive` — mirroring memory_search, so the entity tools don't leak
 * sensitive text to the model on an ordinary profile lookup.
 */
async function entityFactsPayload(
  entityId: number,
  limit: number,
  includeSensitive = false
): Promise<Record<string, unknown>[]> {
  const ids = await getEntityMemoryIds(pool, entityId);
  const rows = (await getMemoriesByIds(pool, ids))
    .filter((r) => (includeSensitive || r.sensitivity !== "sensitive") && viewerCanSee(r))
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
 * Extracts the bare significant tokens from a sanitized FTS query string (the
 * `"a" OR "b"` form produced by sanitizeFtsQuery).
 */
function extractTokens(ftsQuery: string): string[] {
  const quoted = [...ftsQuery.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  return ftsQuery.split(/\s+/).filter((t) => t && !/^(AND|OR|NOT)$/i.test(t));
}

/**
 * Superseded/forgotten rows matching the (sanitized) query — needed so
 * forget/supersede flows can locate records that are no longer active.
 * Tiered like searchCandidates (pg_search BM25 → portable ts_rank → ILIKE),
 * but scoped to `status != 'active'` rows. Never throws for full-text reasons:
 * any tier failure degrades to the next.
 */
async function searchInactive(
  ftsQuery: string,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  if (!ftsQuery.trim()) return [];
  const tokens = extractTokens(ftsQuery);
  if (tokens.length === 0) return [];

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

  // 1. pg_search BM25 (ParadeDB only)
  if (isFtsAvailable()) {
    try {
      const rows = (await pool.query(
        `SELECT ${INACTIVE_FIELDS}
         FROM memories m
         WHERE m.id @@@ $1 AND m.status != 'active'
         ORDER BY paradedb.score(m.id) DESC
         LIMIT $2`,
        [tokens.join(" "), limit]
      )).rows as InactiveDbRow[];
      return rows.map(shape);
    } catch {
      // pg_search query shape mismatch — fall back to ts_rank.
    }
  }

  // 2. Portable Postgres full-text (works on any PG incl. ParadeDB)
  try {
    const tsquery = tokens.join(" | ");
    const rows = (await pool.query(
      `SELECT ${INACTIVE_FIELDS}
       FROM memories m
       WHERE m.status != 'active' AND m.fts @@ to_tsquery('english', $1)
       ORDER BY ts_rank(m.fts, to_tsquery('english', $1)) DESC
       LIMIT $2`,
      [tsquery, limit]
    )).rows as InactiveDbRow[];
    if (rows.length > 0) return rows.map(shape);
  } catch {
    // FTS unavailable — degrade to an ILIKE scan over the tokens.
  }

  // 3. ILIKE OR-scan (last resort), ranked by recency.
  const conditions = tokens.map((_t, i) => `m.text ILIKE $${i + 1}`).join(" OR ");
  const params: unknown[] = tokens.map((t) => `%${t}%`);
  params.push(limit);
  const rows = (await pool.query(
    `SELECT ${INACTIVE_FIELDS}
     FROM memories m
     WHERE m.status != 'active' AND (${conditions})
     ORDER BY m.updated_at DESC, m.id DESC
     LIMIT $${tokens.length + 1}`,
    params
  )).rows as InactiveDbRow[];
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
    guarded(async () => {
      const ftsQuery = sanitizeFtsQuery(query);
      const candidates = (await searchCandidates(pool, ftsQuery)).filter(
        (c) => (include_sensitive || c.sensitivity !== "sensitive") && viewerCanSee(c)
      );
      const ranked = rankMemories(candidates, new Date(), limit);

      const payload: Record<string, unknown> = {
        resultCount: ranked.length,
        results: ranked.map(shapeRow),
      };
      if (include_inactive) {
        const inactive = await searchInactive(ftsQuery, limit);
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
    guarded(async () => {
      const result = await insertFact(pool, {
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
          linked = (await linkFactEntities(pool, result.id, {
            text,
            category,
            entities,
            sourceType: "manual",
          })).linked;
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
    guarded(async () => {
      const row = (await pool.query(
        `SELECT text, status FROM memories WHERE id = $1`,
        [id]
      )).rows[0] as { text: string; status: string } | undefined;
      if (!row) return textResult(`memory ${id} not found`);

      await forgetMemory(pool, id);
      // Withdraw the org-graph edges this fact contributed so a forgotten fact
      // can't keep a stale ownership/role edge alive.
      if (isEntityGraphEnabled()) await retractFactEdges(pool, id);
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
    guarded(async () => {
      const info = await pool.query(
        `UPDATE memories SET status = 'forgotten', updated_at = $1
         WHERE source_ref = $2 AND status = 'active'`,
        [new Date().toISOString(), source_ref]
      );
      return jsonResult({ sourceRef: source_ref, forgottenCount: info.rowCount ?? 0 });
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
    guarded(async () => {
      const old = (await pool.query(
        `SELECT text, category FROM memories WHERE id = $1`,
        [old_id]
      )).rows[0] as { text: string; category: MemoryCategory } | undefined;
      if (!old) return textResult(`memory ${old_id} not found`);

      const result = await supersedeMemory(pool, old_id, {
        text: new_text,
        category: category ?? old.category,
        sourceType: "manual",
        sourceLabel: "Superseded on request via Slack",
        confidence: 0.9,
        // The correction is being asserted now, so it can never be refused as
        // staler than the record it replaces.
        assertedAt: new Date().toISOString(),
      });
      const superseded = result.id !== old_id;
      // The old fact is no longer true, so withdraw the org-graph edges it
      // derived — otherwise a corrected ownership leaves the stale edge active
      // and org_lookup reports both the old and new owner.
      if (superseded && isEntityGraphEnabled()) await retractFactEdges(pool, old_id);
      return jsonResult({
        oldId: old_id,
        oldText: old.text,
        newId: result.id,
        newText: new_text,
        // insertFact may dedup the "new" text onto the old row itself, in
        // which case nothing was superseded.
        superseded,
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
    guarded(async () => {
      const rows = await recentMemories(pool, limit);
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
    guardedEntity(async () => {
      const mentioned = await resolveQueryEntities(pool, query, limit);
      const results = await Promise.all(
        mentioned.map(async (m) => ({
          entityId: m.entityId,
          name: m.name,
          type: m.type,
          factCount: (await getEntityMemoryIds(pool, m.entityId)).length,
        }))
      );
      return jsonResult({
        resultCount: mentioned.length,
        results,
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
    include_sensitive: z.boolean().default(false).describe("Include HR/comp/legal/medical-sensitive facts (excluded by default)"),
  },
  async ({ entity_id, fact_limit, include_sensitive }) =>
    guardedEntity(async () => {
      const e = await getEntityById(pool, entity_id);
      if (!e || e.status !== "active") return textResult(`entity ${entity_id} not found`);
      return jsonResult({
        entityId: e.id,
        name: e.canonicalName,
        type: e.type,
        aliases: e.aliases,
        keyFacts: await entityFactsPayload(e.id, fact_limit, include_sensitive),
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
    include_sensitive: z.boolean().default(false).describe("Include HR/comp/legal/medical-sensitive facts (excluded by default)"),
  },
  async ({ entity_id, limit, include_sensitive }) =>
    guardedEntity(async () => {
      const facts = await entityFactsPayload(entity_id, limit, include_sensitive);
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
    guardedEntity(async () => {
      const team = await getEntityById(pool, team_id);
      if (!team || team.status !== "active") return textResult(`team ${team_id} not found`);
      const roster = await getTeamRoster(pool, team_id);
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
    guardedEntity(async () => {
      const related = await getRelatedEntities(pool, entity_id, relation as EntityRelation);
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
    guardedEntity(async () => {
      const d = await entityDigest(pool, entity_id, Date.now() - days * DAY_MS, viewer ?? undefined);
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
    guardedEntity(async () =>
      jsonResult(await orgDigest(pool, Date.now() - days * DAY_MS, viewer ?? undefined, limit))
    )
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
    guardedEntity(async () => {
      const e = await getEntityById(pool, entity_id);
      if (!e) return textResult(`entity ${entity_id} not found`);
      const forgottenCount = await forgetEntityMemories(pool, entity_id);
      await addEntityExclusion(pool, entity_id, reason, "mcp");
      return jsonResult({ entityId: entity_id, name: e.canonicalName, forgottenCount, excluded: true });
    })
);

// Start server
async function main() {
  // Startup schema guards — NO migrations here: the main process owns the
  // schema. When it has never run against this database, the tools report that
  // instead of crashing (a one-time startup check; servers spawn fresh per req).
  schemaReady = await tableExists(pool, "memories");
  entitiesReady = await tableExists(pool, "entities");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Close the pool on shutdown so the subprocess doesn't leak connections.
async function shutdown(): Promise<void> {
  try {
    await pool.end();
  } catch {
    /* ignore — process is exiting */
  }
}
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

main().catch(async (err) => {
  console.error("Memory MCP server fatal error:", err);
  await shutdown();
  process.exit(1);
});
