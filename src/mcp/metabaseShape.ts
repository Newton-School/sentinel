/**
 * Pure, side-effect-free shaping helpers for the Metabase MCP server.
 *
 * These contain NO `process.env` reads and NO server bootstrap, so they can be
 * imported directly in unit tests. `metabase.ts` performs the authenticated
 * fetch (via `metabaseClient`) and passes the parsed response bodies through
 * these helpers. Auth + the 401 re-auth guard live in `metabaseClient.ts`.
 */

/** The `data` portion of a Metabase /api/dataset or /api/card/:id/query response. */
export interface MetabaseDataset {
  rows: unknown[][];
  cols: { name: string }[];
}

export interface ShapedQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

/**
 * Turn a Metabase rows×cols matrix into an array of column-keyed objects.
 *
 * Metabase returns `cols` (column metadata) and `rows` (a 2-D array of cell
 * values, positionally aligned to `cols`). This zips them into one object per
 * row so callers get `{ columnName: value }` instead of bare positional arrays.
 */
export function shapeQueryResult(data: MetabaseDataset): ShapedQueryResult {
  const columns = data.cols.map((c) => c.name);
  const rows = data.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
  return { columns, rows, rowCount: rows.length };
}

export interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
}

/** Project the verbose /api/dashboard list down to id/name/description. */
export function mapDashboards(
  dashboards: Array<{ id: number; name: string; description: string | null }>
): DashboardSummary[] {
  return dashboards.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
  }));
}

export interface DatabaseSummary {
  id: number;
  name: string;
  engine: string;
}

/** Project the /api/database `data` list down to id/name/engine. */
export function mapDatabases(
  databases: Array<{ id: number; name: string; engine: string }>
): DatabaseSummary[] {
  return databases.map((d) => ({
    id: d.id,
    name: d.name,
    engine: d.engine,
  }));
}
