/**
 * Ground-truth computation for the analytics eval: run the brain's canonical
 * SQL ourselves (read-only, against Altius db 29) so the LLM judge can grade the
 * agent's answer against the TRUE value rather than a rubric alone.
 *
 * Reuses the production Metabase client (src/mcp/metabaseClient.ts) over the
 * REST `/api/dataset` endpoint — the same path the bundled Metabase MCP server
 * uses. CI-safe and fail-soft: returns null (caller treats as "no ground
 * truth") when creds are absent or the query fails. Never throws.
 */

import { config } from "../src/config.js";
import { createMetabaseClient } from "../src/mcp/metabaseClient.js";

/** Altius — the analytics warehouse (per the brain, section 2C / 15). */
export const ALTIUS_DB_ID = 29;

export interface GroundTruthOptions {
  url?: string;
  apiKey?: string;
  username?: string;
  password?: string;
  databaseId?: number;
  /** Max rows to render before truncating (keeps the judge prompt bounded). */
  maxRows?: number;
}

interface DatasetShape {
  status?: string;
  data?: { rows?: unknown[][]; cols?: Array<{ name?: string; display_name?: string }> };
}

/**
 * Render a Metabase /api/dataset result into a compact string for the judge:
 * a bare scalar for a 1x1 result, otherwise a header + up to maxRows of rows.
 * Returns null for an errored/failed/malformed result.
 */
export function formatDatasetResult(result: unknown, maxRows: number): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as DatasetShape;
  // Metabase signals a non-completed query via `status` (e.g. "failed").
  if (r.status && r.status !== "completed") return null;
  const rows = r.data?.rows;
  if (!Array.isArray(rows)) return null;
  if (rows.length === 0) return "(no rows)";
  if (rows.length === 1 && rows[0].length === 1) return String(rows[0][0]);

  const cols = Array.isArray(r.data?.cols)
    ? r.data!.cols!.map((c) => c.display_name ?? c.name ?? "")
    : [];
  const header = cols.length ? cols.join(" | ") + "\n" : "";
  const body = rows
    .slice(0, maxRows)
    .map((row) => row.map((c) => (c === null || c === undefined ? "" : String(c))).join(" | "))
    .join("\n");
  const more = rows.length > maxRows ? `\n… (${rows.length - maxRows} more rows)` : "";
  return header + body + more;
}

/**
 * Run read-only SQL against Altius and return a compact result string, or null
 * when creds are missing or the query fails.
 */
export async function computeGroundTruth(
  sql: string,
  opts: GroundTruthOptions = {}
): Promise<string | null> {
  const url = opts.url ?? config.METABASE_URL;
  const apiKey = opts.apiKey ?? config.METABASE_API_KEY;
  const username = opts.username ?? config.METABASE_USERNAME;
  const password = opts.password ?? config.METABASE_PASSWORD;

  // Same credential rule as the bundled Metabase server: URL + (key OR user/pass).
  if (!url || (!apiKey && !(username && password))) return null;

  try {
    const client = createMetabaseClient({ url, apiKey, username, password });
    const result = await client.metabaseFetch("/api/dataset", {
      method: "POST",
      body: JSON.stringify({
        database: opts.databaseId ?? ALTIUS_DB_ID,
        type: "native",
        native: { query: sql },
      }),
    });
    return formatDatasetResult(result, opts.maxRows ?? 20);
  } catch {
    return null;
  }
}
