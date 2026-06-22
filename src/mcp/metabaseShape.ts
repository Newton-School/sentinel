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

/** The raw shape of a single dashboard from GET /api/dashboard/:id. */
export interface DashboardDetailResponse {
  id: number;
  name: string;
  description?: string | null;
  tabs?: Array<{ id: number; name: string }> | null;
  dashcards?: Array<{
    id: number;
    dashboard_tab_id?: number | null;
    card?: { id: number; name?: string } | null;
  }> | null;
}

export interface DashboardCardRef {
  card_id: number;
  name: string;
  /** Which dashboard tab the card lives on, or null for an untabbed dashboard. */
  tab_id: number | null;
}

export interface DashboardDetail {
  id: number;
  name: string;
  description: string | null;
  tabs: Array<{ id: number; name: string }>;
  cards: DashboardCardRef[];
}

/**
 * Project GET /api/dashboard/:id down to the dashboard meta, its tabs, and the
 * saved-question (card) IDs each card sits on. Virtual dashcards (headings/text)
 * carry no `card` and are dropped — only real cards are returned so the agent
 * can then run them via `metabase_get_question` / read their SQL via
 * `metabase_get_card_sql`.
 */
export function mapDashboardDetail(dash: DashboardDetailResponse): DashboardDetail {
  const cards: DashboardCardRef[] = (dash.dashcards ?? [])
    .filter((dc): dc is typeof dc & { card: { id: number; name?: string } } =>
      dc.card != null && typeof dc.card.id === "number"
    )
    .map((dc) => ({
      card_id: dc.card.id,
      name: dc.card.name ?? "",
      tab_id: dc.dashboard_tab_id ?? null,
    }));

  return {
    id: dash.id,
    name: dash.name,
    description: dash.description ?? null,
    tabs: (dash.tabs ?? []).map((t) => ({ id: t.id, name: t.name })),
    cards,
  };
}

/** A Metabase card parameter (from `card.parameters`), reused to run the card. */
export interface CardParameter {
  slug?: string;
  name?: string;
  type?: string;
  /** Metabase parameter target, e.g. ["variable", ["template-tag", "course"]]. */
  target?: unknown;
}

/** The (partial) raw shape of a card from GET /api/card/:id. */
export interface CardDetailResponse {
  id: number;
  name: string;
  /** Top-level query kind ("native" | "query") — present even in pMBQL cards. */
  query_type?: string | null;
  database_id?: number | null;
  parameters?: CardParameter[] | null;
  dataset_query?: {
    type?: string;
    database?: number | null;
    native?: {
      query?: string;
      "template-tags"?: Record<string, unknown> | null;
    } | null;
    // New pMBQL (Metabase Lib) format: native SQL lives in stages[].native.
    stages?: Array<{ native?: unknown }> | null;
  } | null;
}

export interface CardSqlSummary {
  id: number;
  name: string;
  database_id: number | null;
  /** "native" for SQL cards, "query" for MBQL cards, "unknown" if absent. */
  query_type: string;
  /** The raw native SQL, or null for MBQL/non-native cards. */
  sql: string | null;
  /** Template-tag (`{{param}}`) names declared on the card. */
  parameters: string[];
}

/**
 * Project GET /api/card/:id down to the card's underlying native SQL +
 * parameters. This is the canonical query a dashboard card runs, so the agent
 * can reproduce a dashboard number exactly instead of hand-writing funnel SQL.
 */
export function mapCardSql(card: CardDetailResponse): CardSqlSummary {
  const dq = card.dataset_query ?? {};
  const native = dq.native ?? {};
  const templateTags = native["template-tags"] ?? {};

  // Parameter slugs come from card.parameters (the pMBQL source) unioned with
  // legacy native template-tags, so the agent learns what to pass to run it.
  const paramSlugs = (card.parameters ?? [])
    .map((p) => p.slug ?? p.name)
    .filter((s): s is string => typeof s === "string");
  const parameters = Array.from(new Set([...paramSlugs, ...Object.keys(templateTags)]));

  return {
    id: card.id,
    name: card.name,
    database_id: card.database_id ?? dq.database ?? null,
    query_type:
      typeof card.query_type === "string"
        ? card.query_type
        : typeof dq.type === "string"
          ? dq.type
          : "unknown",
    sql: extractNativeSql(dq),
    parameters,
  };
}

/**
 * Find the native SQL on a card's dataset_query, supporting both the legacy
 * shape (`native.query`) and the new pMBQL shape (`stages[].native`).
 */
function extractNativeSql(dq: NonNullable<CardDetailResponse["dataset_query"]>): string | null {
  if (typeof dq.native?.query === "string") return dq.native.query;
  for (const stage of dq.stages ?? []) {
    if (typeof stage.native === "string") return stage.native;
  }
  return null;
}
