#!/usr/bin/env node

/**
 * Metabase MCP Server — exposes Metabase API as MCP tools for Claude CLI.
 * Runs as a stdio-based MCP server, spawned by Claude via --mcp-config.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { assertReadOnlySql } from "./sqlReadOnly.js";

const METABASE_URL = process.env.METABASE_URL!;
const METABASE_USERNAME = process.env.METABASE_USERNAME!;
const METABASE_PASSWORD = process.env.METABASE_PASSWORD!;

let sessionToken: string | null = null;

async function getSession(): Promise<string> {
  if (sessionToken) return sessionToken;

  const res = await fetch(`${METABASE_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: METABASE_USERNAME,
      password: METABASE_PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new Error(`Metabase auth failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { id: string };
  sessionToken = data.id;
  return sessionToken;
}

async function metabaseFetch(
  path: string,
  options: RequestInit = {}
): Promise<unknown> {
  const token = await getSession();
  const res = await fetch(`${METABASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Metabase-Session": token,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    // Token expired, retry with fresh session
    sessionToken = null;
    const newToken = await getSession();
    const retry = await fetch(`${METABASE_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Metabase-Session": newToken,
        ...options.headers,
      },
    });
    return retry.json();
  }

  if (!res.ok) {
    throw new Error(`Metabase API error: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

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
    })) as {
      data: {
        rows: unknown[][];
        cols: { name: string }[];
      };
    };

    const cols = result.data.cols.map((c) => c.name);
    const rows = result.data.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ columns: cols, rows, rowCount: rows.length }, null, 2),
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
    )) as {
      data: {
        rows: unknown[][];
        cols: { name: string }[];
      };
    };

    const cols = result.data.cols.map((c) => c.name);
    const rows = result.data.rows.map((row) => {
      const obj: Record<string, unknown> = {};
      cols.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ columns: cols, rows, rowCount: rows.length }, null, 2),
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

    const summary = dashboards.map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
    }));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(summary, null, 2),
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
          text: JSON.stringify(
            result.data.map((d) => ({
              id: d.id,
              name: d.name,
              engine: d.engine,
            })),
            null,
            2
          ),
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
