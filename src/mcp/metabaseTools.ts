/**
 * Pure tool-handler logic for the Metabase MCP server.
 *
 * Each function takes an injected `metabaseFetch` (the authenticated fetch from
 * `metabaseClient`) plus the tool args, and returns an MCP tool result. Keeping
 * the logic here — separate from `metabase.ts`, which only reads `process.env`,
 * builds the client, and wires these onto an `McpServer` — means the exact HTTP
 * method + path each tool issues is unit-testable with a mock fetch (see
 * `tests/metabaseTools.test.ts`), without booting a stdio server.
 */

import { assertReadOnlySql } from "./sqlReadOnly.js";
import {
  shapeQueryResult,
  mapDashboards,
  mapDatabases,
  mapDashboardDetail,
  mapCardSql,
  type MetabaseDataset,
  type DashboardDetailResponse,
  type CardDetailResponse,
  type CardParameter,
} from "./metabaseShape.js";

/** A scalar value supplied for a card parameter (slug → value). */
export type CardParameterValues = Record<string, string | number | boolean>;

/**
 * Build the Metabase `parameters` array for running a saved card, reusing each
 * card parameter's `type` + `target` and injecting the caller's value, matched
 * by slug (or name). Slugs with no matching card parameter are skipped so we
 * never send an unknown parameter that Metabase would reject with a 400.
 */
export function buildCardParameters(
  cardParameters: CardParameter[],
  values: CardParameterValues
): Array<{ type: string; target: unknown; value: unknown }> {
  const out: Array<{ type: string; target: unknown; value: unknown }> = [];
  for (const p of cardParameters) {
    const slug = p.slug ?? p.name;
    if (
      slug != null &&
      Object.prototype.hasOwnProperty.call(values, slug) &&
      p.type != null &&
      p.target != null
    ) {
      out.push({ type: p.type, target: p.target, value: values[slug] });
    }
  }
  return out;
}

/** The authenticated fetch contract provided by `metabaseClient`. */
export type MetabaseFetch = (path: string, options?: RequestInit) => Promise<unknown>;

export interface ToolResult {
  // Index signature mirrors the MCP SDK's CallToolResult so these functions are
  // assignable directly as `server.tool` callbacks.
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Wrap a value as the single JSON text block MCP tools return. */
function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

/**
 * Run a read-only SQL query via Metabase's native /api/dataset endpoint.
 * Enforces read-only access at the tool boundary BEFORE forwarding to the
 * warehouse — the agent auto-approves MCP calls, so a prompt-injected or
 * hallucinated mutating statement must be rejected here.
 */
export async function runQuery(
  metabaseFetch: MetabaseFetch,
  sql: string,
  database_id: number
): Promise<ToolResult> {
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

  return textResult(shapeQueryResult(result.data));
}

/**
 * RUN a saved question/card and return its rows. Metabase's run-card endpoint is
 * POST /api/card/:id/query — a GET there matches no route and 404s, which was the
 * #testing-kpis "card 10142 → 404" bug.
 */
export async function getQuestion(
  metabaseFetch: MetabaseFetch,
  question_id: number,
  parameters?: CardParameterValues
): Promise<ToolResult> {
  const options: RequestInit = { method: "POST" };

  // Parameterized dashboard cards (start_date/course/team_lead/…) 400 if run
  // bare. When the caller supplies values, fetch the card's parameter defs and
  // build the run body by reusing each param's target/type with the new value.
  if (parameters && Object.keys(parameters).length > 0) {
    const card = (await metabaseFetch(`/api/card/${question_id}`)) as CardDetailResponse;
    const built = buildCardParameters(card.parameters ?? [], parameters);
    options.body = JSON.stringify({ parameters: built });
  }

  const result = (await metabaseFetch(
    `/api/card/${question_id}/query`,
    options
  )) as { data: MetabaseDataset };

  return textResult(shapeQueryResult(result.data));
}

/**
 * Read a saved card's DEFINITION (GET /api/card/:id) and return its underlying
 * native SQL + parameters. This is the canonical query behind a dashboard card,
 * so the agent can reproduce a dashboard number exactly instead of guessing the
 * funnel logic.
 */
export async function getCardSql(
  metabaseFetch: MetabaseFetch,
  card_id: number
): Promise<ToolResult> {
  const card = (await metabaseFetch(`/api/card/${card_id}`)) as CardDetailResponse;
  return textResult(mapCardSql(card));
}

/**
 * Fetch a single dashboard by ID (GET /api/dashboard/:id), including its tabs and
 * the cards it contains. The server otherwise only has a list-all tool, so a
 * dashboard URL (e.g. 485/528) could never be opened — the missing-capability
 * half of "sentinel cannot read dashboards".
 */
export async function getDashboard(
  metabaseFetch: MetabaseFetch,
  dashboard_id: number
): Promise<ToolResult> {
  const dash = (await metabaseFetch(
    `/api/dashboard/${dashboard_id}`
  )) as DashboardDetailResponse;
  return textResult(mapDashboardDetail(dash));
}

/** List all dashboards (GET /api/dashboard) as id/name/description. */
export async function listDashboards(metabaseFetch: MetabaseFetch): Promise<ToolResult> {
  const dashboards = (await metabaseFetch("/api/dashboard")) as Array<{
    id: number;
    name: string;
    description: string | null;
  }>;
  return textResult(mapDashboards(dashboards));
}

/** List databases connected to Metabase (GET /api/database) as id/name/engine. */
export async function listDatabases(metabaseFetch: MetabaseFetch): Promise<ToolResult> {
  const result = (await metabaseFetch("/api/database")) as {
    data: Array<{ id: number; name: string; engine: string }>;
  };
  return textResult(mapDatabases(result.data));
}
