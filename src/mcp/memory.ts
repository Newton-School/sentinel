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
} from "../memory/memorySql.js";
import { rankMemories, sanitizeFtsQuery } from "../memory/rank.js";
import type { MemoryCategory, MemoryRow } from "../memory/types.js";
import { assertEnv } from "./requireEnv.js";

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
  },
  async ({ query, limit, include_inactive }) =>
    guarded(() => {
      const ftsQuery = sanitizeFtsQuery(query);
      const candidates = searchCandidates(db, ftsQuery);
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
  },
  async ({ text, category, entities }) =>
    guarded(() => {
      const result = insertFact(db, {
        text,
        category,
        entities,
        sourceType: "manual",
        sourceLabel: "Stored on request via Slack",
        confidence: 0.9,
      });
      return jsonResult({
        id: result.id,
        deduped: result.deduped,
        text,
        category,
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

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Memory MCP server fatal error:", err);
  process.exit(1);
});
