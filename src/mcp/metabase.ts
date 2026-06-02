#!/usr/bin/env node

/**
 * Metabase MCP Server — exposes Metabase API as MCP tools for Claude CLI.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertReadOnlySql } from "./sqlReadOnly.js";
import { createMetabaseClient } from "./metabaseClient.js";
import {
  shapeQueryResult,
  mapDashboards,
  mapDatabases,
  type MetabaseDataset,
} from "./metabaseShape.js";
import { assertEnv } from "./requireEnv.js";

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of e.g. fetch('undefined/api/session') later.
assertEnv(["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD"], process.env, {
  serverName: "metabase MCP server",
});

// Build a single client from the environment. Auth + fetch (incl. the 401
// re-auth retry guard) live in the side-effect-free metabaseClient module.
const client = createMetabaseClient({
  url: process.env.METABASE_URL!,
  username: process.env.METABASE_USERNAME!,
  password: process.env.METABASE_PASSWORD!,
});

const metabaseFetch = client.metabaseFetch;

// Create MCP server
const server = new McpServer({
  name: "metabase",
  version: "0.1.0",
});

// Tool: Run a SQL query via Metabase's native query endpoint
server.tool(
  "metabase_query",
  "Run a SQL query against the Metabase data warehouse. Returns rows as JSON.",
  {
    sql: z.string().describe("The SQL query to execute"),
    database_id: z
      .number()
      .default(1)
      .describe("Metabase database ID (default: 1)"),
  },
  async ({ sql, database_id }) => {
    // Enforce read-only access at the tool boundary. The Claude CLI runs with
    // --dangerously-skip-permissions, so a prompt-injected or hallucinated
    // mutating statement must be rejected before it reaches the warehouse.
    try {
      assertReadOnlySql(sql);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: reason.startsWith("Rejected:") ? reason : `Rejected: ${reason}`,
          },
        ],
        isError: true,
      };
    }

    const result = (await metabaseFetch("/api/dataset", {
      method: "POST",
      body: JSON.stringify({
        database: database_id,
        type: "native",
        native: { query: sql },
      }),
    })) as { data: MetabaseDataset };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(shapeQueryResult(result.data), null, 2),
        },
      ],
    };
  }
);

// Tool: Get a saved question (card) by ID
server.tool(
  "metabase_get_question",
  "Fetch results from a saved Metabase question/card by its ID.",
  {
    question_id: z.number().describe("The Metabase question (card) ID"),
  },
  async ({ question_id }) => {
    const result = (await metabaseFetch(
      `/api/card/${question_id}/query`
    )) as { data: MetabaseDataset };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(shapeQueryResult(result.data), null, 2),
        },
      ],
    };
  }
);

// Tool: List dashboards
server.tool(
  "metabase_list_dashboards",
  "List all Metabase dashboards. Returns dashboard names and IDs.",
  {},
  async () => {
    const dashboards = (await metabaseFetch("/api/dashboard")) as Array<{
      id: number;
      name: string;
      description: string | null;
    }>;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(mapDashboards(dashboards), null, 2),
        },
      ],
    };
  }
);

// Tool: List databases
server.tool(
  "metabase_list_databases",
  "List all databases connected to Metabase. Use this to find the correct database_id for SQL queries.",
  {},
  async () => {
    const result = (await metabaseFetch("/api/database")) as {
      data: Array<{ id: number; name: string; engine: string }>;
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(mapDatabases(result.data), null, 2),
        },
      ],
    };
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Metabase MCP server fatal error:", err);
  process.exit(1);
});
