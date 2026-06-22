#!/usr/bin/env node

/**
 * Metabase MCP Server — exposes Metabase API as MCP tools for the agent harness.
 * Runs as a stdio-based MCP server, spawned by the agent harness over stdio MCP.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createMetabaseClient } from "./metabaseClient.js";
import {
  runQuery,
  getQuestion,
  getCardSql,
  getDashboard,
  listDashboards,
  listDatabases,
} from "./metabaseTools.js";
import { assertEnv } from "./requireEnv.js";

// Validate required env up front so a misconfigured server fails with a clear
// named message instead of e.g. fetch('undefined/api/session') later. API-key
// auth needs only the URL; session auth additionally needs username+password.
assertEnv(
  process.env.METABASE_API_KEY
    ? ["METABASE_URL"]
    : ["METABASE_URL", "METABASE_USERNAME", "METABASE_PASSWORD"],
  process.env,
  { serverName: "metabase MCP server" }
);

// Build a single client from the environment. The client picks its auth mode:
// X-API-KEY when METABASE_API_KEY is set, otherwise the username/password
// session flow (incl. the 401 re-auth retry guard). Both live in the
// side-effect-free metabaseClient module.
const client = createMetabaseClient({
  url: process.env.METABASE_URL!,
  apiKey: process.env.METABASE_API_KEY,
  username: process.env.METABASE_USERNAME,
  password: process.env.METABASE_PASSWORD,
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
  async ({ sql, database_id }) => runQuery(metabaseFetch, sql, database_id)
);

// Tool: Run a saved question (card) by ID and return its rows.
server.tool(
  "metabase_get_question",
  "Run a saved Metabase question/card by its ID and return the resulting rows. For a parameterized dashboard card (e.g. start_date/end_date/course/team_lead), pass `parameters` as a {slug: value} map — get the slugs from metabase_get_card_sql and the values from the dashboard URL's query string. Running a parameterized card without its parameters fails.",
  {
    question_id: z.number().describe("The Metabase question (card) ID"),
    parameters: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe(
        'Optional map of card parameter slug → value, e.g. {"start_date":"2026-06-13","course":"Full Course"}.'
      ),
  },
  async ({ question_id, parameters }) =>
    getQuestion(metabaseFetch, question_id, parameters)
);

// Tool: Read a saved question's underlying SQL definition (not its rows).
server.tool(
  "metabase_get_card_sql",
  "Read the underlying native SQL + parameters of a saved Metabase question/card by its ID. Use this to reproduce a dashboard card's exact numbers instead of hand-writing the query.",
  {
    card_id: z.number().describe("The Metabase question (card) ID"),
  },
  async ({ card_id }) => getCardSql(metabaseFetch, card_id)
);

// Tool: Fetch a single dashboard by ID, including its tabs and cards.
server.tool(
  "metabase_get_dashboard",
  "Fetch a Metabase dashboard by its ID, including its tabs and the cards (saved question IDs) it contains. Use this to open a dashboard URL, then read/run the cards via metabase_get_card_sql / metabase_get_question.",
  {
    dashboard_id: z.number().describe("The Metabase dashboard ID"),
  },
  async ({ dashboard_id }) => getDashboard(metabaseFetch, dashboard_id)
);

// Tool: List dashboards
server.tool(
  "metabase_list_dashboards",
  "List all Metabase dashboards. Returns dashboard names and IDs.",
  {},
  async () => listDashboards(metabaseFetch)
);

// Tool: List databases
server.tool(
  "metabase_list_databases",
  "List all databases connected to Metabase. Use this to find the correct database_id for SQL queries.",
  {},
  async () => listDatabases(metabaseFetch)
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
