/**
 * Read-only "company brain" query layer for the dashboard: entities, the
 * relationship graph, entity dossiers, memories (facts), and personas.
 *
 * Like src/dashboard/queries.ts it is self-contained SELECT SQL over a
 * Queryable (so it stays config-free and runs against the SELECT-only pool),
 * and it reuses the *config-free* ACL predicate from src/access/scope.ts to
 * enforce visibility + sensitivity SERVER-side per row — never in the UI.
 */

import type { Queryable } from "../state/db.js";
import { buildViewerScope, canView, type Role, type ViewerScope } from "../access/scope.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function clampLimit(n: number | undefined, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function parseJsonArray(s: unknown): string[] {
  if (typeof s !== "string" || s === "") return [];
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * The dashboard's viewer for ACL purposes. In the active 'founders' mode this
 * role is the whole gate (a founder sees everything; anyone else sees nothing),
 * so deployments should match the Ingress auth group to this role.
 */
export function dashboardViewerScope(role: Role): ViewerScope {
  return buildViewerScope("dashboard", {
    founderUserIds: role === "founder" ? ["dashboard"] : [],
    roleMap: { dashboard: role },
  });
}

// ── Entities ───────────────────────────────────────────────────────────────

export interface EntitySummary {
  id: number;
  type: string;
  canonicalName: string;
  aliases: string[];
  status: string;
  visibility: string;
  factCount: number;
  slackUserId: string | null;
  email: string | null;
  updatedAt: string;
}

function mapEntity(r: Record<string, unknown>): EntitySummary {
  return {
    id: r.id as number,
    type: r.type as string,
    canonicalName: r.canonical_name as string,
    aliases: parseJsonArray(r.aliases),
    status: r.status as string,
    visibility: r.visibility as string,
    factCount: (r.fact_count as number) ?? 0,
    slackUserId: (r.slack_user_id as string | null) ?? null,
    email: (r.email as string | null) ?? null,
    updatedAt: r.updated_at as string,
  };
}

const entityVisible = (e: { visibility: string }, viewer: ViewerScope) =>
  canView({ visibility: e.visibility }, viewer);

export interface ListEntitiesOpts {
  type?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listEntities(
  db: Queryable,
  viewer: ViewerScope,
  opts: ListEntitiesOpts = {}
): Promise<EntitySummary[]> {
  const { rows } = await db.query(
    `SELECT e.id, e.type, e.canonical_name, e.aliases, e.status, e.visibility,
            e.slack_user_id, e.email, e.updated_at, COALESCE(p.fact_count, 0) AS fact_count
     FROM entities e
     LEFT JOIN entity_profiles p ON p.entity_id = e.id
     WHERE e.status = 'active'
       AND ($1::text IS NULL OR e.type = $1)
       AND ($2::text IS NULL OR e.canonical_name ILIKE '%' || $2 || '%' OR e.normalized_name ILIKE '%' || $2 || '%')
     ORDER BY fact_count DESC, e.updated_at DESC
     LIMIT $3 OFFSET $4`,
    [opts.type ?? null, opts.search ?? null, clampLimit(opts.limit), Math.max(0, Math.floor(opts.offset ?? 0))]
  );
  return rows.map(mapEntity).filter((e) => entityVisible(e, viewer));
}

// ── Graph ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: number;
  type: string;
  name: string;
  factCount: number;
}
export interface GraphEdge {
  src: number;
  dst: number;
  relation: string;
  confidence: number;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  capped: boolean;
}

export interface GraphOpts {
  types?: string[];
  minConfidence?: number;
  nodeLimit?: number;
}

export async function getGraph(
  db: Queryable,
  viewer: ViewerScope,
  opts: GraphOpts = {}
): Promise<Graph> {
  const nodeLimit = clampLimit(opts.nodeLimit, 100, 300);
  const types = opts.types && opts.types.length ? opts.types : null;
  // Fetch one extra to detect whether the result was capped.
  const { rows: nodeRows } = await db.query(
    `SELECT e.id, e.type, e.canonical_name, e.visibility, COALESCE(p.fact_count, 0) AS fact_count
     FROM entities e
     LEFT JOIN entity_profiles p ON p.entity_id = e.id
     WHERE e.status = 'active' AND ($1::text[] IS NULL OR e.type = ANY($1))
     ORDER BY fact_count DESC, e.updated_at DESC
     LIMIT $2`,
    [types, nodeLimit + 1]
  );
  const capped = nodeRows.length > nodeLimit;
  const visible = nodeRows
    .slice(0, nodeLimit)
    .filter((r) => canView({ visibility: r.visibility as string }, viewer));
  const ids = visible.map((r) => r.id as number);

  let edges: GraphEdge[] = [];
  if (ids.length) {
    const { rows: edgeRows } = await db.query(
      `SELECT src_id, dst_id, relation, confidence
       FROM entity_edges
       WHERE status = 'active' AND src_id = ANY($1) AND dst_id = ANY($1)
         AND ($2::float8 IS NULL OR confidence >= $2)`,
      [ids, opts.minConfidence ?? null]
    );
    edges = edgeRows.map((e: Record<string, unknown>) => ({
      src: e.src_id as number,
      dst: e.dst_id as number,
      relation: e.relation as string,
      confidence: e.confidence as number,
    }));
  }

  return {
    nodes: visible.map((r) => ({
      id: r.id as number,
      type: r.type as string,
      name: r.canonical_name as string,
      factCount: (r.fact_count as number) ?? 0,
    })),
    edges,
    capped,
  };
}

// ── Memories (facts) ─────────────────────────────────────────────────────────

export interface MemorySummary {
  id: number;
  text: string;
  category: string;
  entities: string[];
  sourceType: string;
  sourceLabel: string | null;
  speaker: string | null;
  assertedAt: string | null;
  evidenceQuote: string | null;
  confidence: number;
  verified: boolean;
  visibility: string;
  sensitivity: string;
  createdAt: string;
}

const MEM_COL_NAMES = [
  "id", "text", "category", "entities", "source_type", "source_label", "speaker",
  "asserted_at", "evidence_quote", "confidence", "verified", "visibility", "sensitivity", "created_at",
];
// Qualify columns (e.g. with "m") when the query joins another table that shares
// column names like `confidence`/`created_at` (memory_entities does).
const memCols = (prefix = ""): string =>
  MEM_COL_NAMES.map((c) => (prefix ? `${prefix}.${c}` : c)).join(", ");

function mapMemory(r: Record<string, unknown>): MemorySummary {
  return {
    id: r.id as number,
    text: r.text as string,
    category: r.category as string,
    entities: parseJsonArray(r.entities),
    sourceType: r.source_type as string,
    sourceLabel: (r.source_label as string | null) ?? null,
    speaker: (r.speaker as string | null) ?? null,
    assertedAt: (r.asserted_at as string | null) ?? null,
    evidenceQuote: (r.evidence_quote as string | null) ?? null,
    confidence: r.confidence as number,
    verified: r.verified === 1 || r.verified === true,
    visibility: r.visibility as string,
    sensitivity: r.sensitivity as string,
    createdAt: r.created_at as string,
  };
}

const memoryVisible = (m: MemorySummary, viewer: ViewerScope, showSensitive: boolean) => {
  if (!showSensitive && m.sensitivity === "sensitive") return false;
  return canView({ visibility: m.visibility, sensitivity: m.sensitivity }, viewer);
};

export interface ListMemoriesOpts {
  category?: string;
  sourceType?: string;
  since?: string;
  search?: string;
  showSensitive?: boolean;
  limit?: number;
}

export async function listMemories(
  db: Queryable,
  viewer: ViewerScope,
  opts: ListMemoriesOpts = {}
): Promise<MemorySummary[]> {
  const showSensitive = opts.showSensitive ?? false;
  const { rows } = await db.query(
    `SELECT ${memCols()} FROM memories
     WHERE status = 'active'
       AND ($1::text IS NULL OR category = $1)
       AND ($2::text IS NULL OR source_type = $2)
       AND ($3::text IS NULL OR created_at >= $3)
       AND ($4::text IS NULL OR text ILIKE '%' || $4 || '%')
       AND ($5::boolean OR sensitivity <> 'sensitive')
     ORDER BY created_at DESC
     LIMIT $6`,
    [opts.category ?? null, opts.sourceType ?? null, opts.since ?? null, opts.search ?? null, showSensitive, clampLimit(opts.limit)]
  );
  return rows.map(mapMemory).filter((m) => memoryVisible(m, viewer, showSensitive));
}

// ── Entity detail (dossier) ──────────────────────────────────────────────────

export interface Relationship {
  relation: string;
  direction: "out" | "in";
  otherId: number;
  otherName: string;
  otherType: string;
  confidence: number;
}

export interface EntityDetail {
  entity: EntitySummary;
  profileMd: string | null;
  builtAt: string | null;
  relationships: Relationship[];
  backingFacts: MemorySummary[];
}

export async function getEntityDetail(
  db: Queryable,
  id: number,
  viewer: ViewerScope
): Promise<EntityDetail | null> {
  const { rows } = await db.query(
    `SELECT e.id, e.type, e.canonical_name, e.aliases, e.status, e.visibility,
            e.slack_user_id, e.email, e.updated_at, COALESCE(p.fact_count, 0) AS fact_count,
            p.profile_md, p.built_at
     FROM entities e
     LEFT JOIN entity_profiles p ON p.entity_id = e.id
     WHERE e.id = $1`,
    [id]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.status !== "active") return null;
  const entity = mapEntity(row);
  if (!entityVisible(entity, viewer)) return null;

  const { rows: edgeRows } = await db.query(
    `SELECT ee.relation, ee.confidence,
            CASE WHEN ee.src_id = $1 THEN 'out' ELSE 'in' END AS direction,
            CASE WHEN ee.src_id = $1 THEN ee.dst_id ELSE ee.src_id END AS other_id,
            o.canonical_name AS other_name, o.type AS other_type,
            o.visibility AS other_visibility, o.status AS other_status
     FROM entity_edges ee
     JOIN entities o ON o.id = CASE WHEN ee.src_id = $1 THEN ee.dst_id ELSE ee.src_id END
     WHERE ee.status = 'active' AND (ee.src_id = $1 OR ee.dst_id = $1)
     ORDER BY ee.confidence DESC`,
    [id]
  );
  const relationships: Relationship[] = edgeRows
    .filter((r: Record<string, unknown>) => r.other_status === "active" && canView({ visibility: r.other_visibility as string }, viewer))
    .map((r: Record<string, unknown>) => ({
      relation: r.relation as string,
      direction: r.direction as "out" | "in",
      otherId: r.other_id as number,
      otherName: r.other_name as string,
      otherType: r.other_type as string,
      confidence: r.confidence as number,
    }));

  const { rows: factRows } = await db.query(
    `SELECT ${memCols("m")} FROM memory_entities me
     JOIN memories m ON m.id = me.memory_id
     WHERE me.entity_id = $1 AND m.status = 'active'
     ORDER BY m.created_at DESC
     LIMIT 100`,
    [id]
  );
  const backingFacts = factRows.map(mapMemory).filter((m) => memoryVisible(m, viewer, false));

  return {
    entity,
    profileMd: (row.profile_md as string | null) ?? null,
    builtAt: (row.built_at as string | null) ?? null,
    relationships,
    backingFacts,
  };
}

// ── Personas ─────────────────────────────────────────────────────────────────

export interface PersonaSummary {
  userId: string;
  displayName: string;
  role: string | null;
  updatedAt: string;
}
export interface PersonaTraitRow {
  label: string;
  value: string;
  confidence: number;
  evidenceCount: number;
  updatedAt: string;
}
export interface PersonaDetail extends PersonaSummary {
  traits: PersonaTraitRow[];
}

export async function listPersonas(db: Queryable, opts: { limit?: number } = {}): Promise<PersonaSummary[]> {
  const { rows } = await db.query(
    `SELECT user_id, display_name, role, updated_at FROM personas ORDER BY updated_at DESC LIMIT $1`,
    [clampLimit(opts.limit)]
  );
  return rows.map((r: Record<string, unknown>) => ({
    userId: r.user_id as string,
    displayName: r.display_name as string,
    role: (r.role as string | null) ?? null,
    updatedAt: r.updated_at as string,
  }));
}

export async function getPersona(db: Queryable, userId: string): Promise<PersonaDetail | null> {
  const { rows } = await db.query(
    `SELECT user_id, display_name, role, updated_at FROM personas WHERE user_id = $1`,
    [userId]
  );
  const p = rows[0] as Record<string, unknown> | undefined;
  if (!p) return null;
  const { rows: traits } = await db.query(
    `SELECT label, value, confidence, evidence_count, updated_at FROM persona_traits
     WHERE user_id = $1 ORDER BY confidence DESC, evidence_count DESC`,
    [userId]
  );
  return {
    userId: p.user_id as string,
    displayName: p.display_name as string,
    role: (p.role as string | null) ?? null,
    updatedAt: p.updated_at as string,
    traits: traits.map((t: Record<string, unknown>) => ({
      label: t.label as string,
      value: t.value as string,
      confidence: t.confidence as number,
      evidenceCount: t.evidence_count as number,
      updatedAt: t.updated_at as string,
    })),
  };
}
