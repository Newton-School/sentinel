/**
 * All SQL for the company-brain entity graph.
 *
 * Like `memorySql.ts`, every function takes a `Queryable` (the pg Pool, a
 * transaction client, or the per-request memory MCP server's own pool) as its
 * FIRST argument and never calls `getPool()` — the separate-process memory MCP
 * server binds its own pool to the same database. Keep this module free of
 * main-process singletons and config. Functions that must be atomic take a
 * `DbPool` instead and open their own transaction via `withTxOn`.
 *
 * Patterns reused verbatim from the memory store:
 *  - asymptotic confidence growth on reinforcement (persona_traits)
 *  - merge-via-supersede in a deferred-FK transaction (supersedeMemory)
 *  - normalizeForHash for the indexed exact-match key (content_hash)
 */

import { withTxOn, type DbPool, type Queryable } from "../state/db.js";
import { normalizeForHash, tokenSet } from "./textMatch.js";
import { decayedEdgeConfidence, EDGE_DISPLAY_THRESHOLD } from "./edgeDecay.js";
import type {
  EntityCandidate,
  EntityType,
  ResolveInput,
} from "./entityResolve.js";

/** Asymptotic confidence growth per reinforcing signal (persona_traits parity). */
export const EDGE_CONFIDENCE_GROWTH = 0.15;
/** Hard ceiling on grown edge confidence. */
export const EDGE_CONFIDENCE_CAP = 0.95;

export type EntityStatus = "active" | "merged" | "forgotten";
export type EntityRelation =
  | "member_of"
  | "manages"
  | "reports_to"
  | "owns"
  | "works_on"
  | "depends_on"
  | "part_of"
  | "related_to";
export type MemoryEntityRole = "subject" | "owner" | "mention" | "about";

export interface EntityRow {
  id: number;
  type: EntityType;
  canonicalName: string;
  normalizedName: string;
  aliases: string[];
  slackUserId: string | null;
  email: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number;
  visibility: string;
  status: EntityStatus;
  mergedInto: number | null;
  sourceRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntityEdgeRow {
  id: number;
  srcId: number;
  dstId: number;
  relation: EntityRelation;
  confidence: number;
  evidenceCount: number;
  provenance: string | null;
  assertedAt: string | null;
  status: "active" | "superseded" | "forgotten";
  createdAt: string;
  updatedAt: string;
}

interface EntityDbRow {
  id: number;
  type: EntityType;
  canonical_name: string;
  normalized_name: string;
  aliases: string | null;
  slack_user_id: string | null;
  email: string | null;
  metadata: string | null;
  confidence: number;
  visibility: string;
  status: EntityStatus;
  merged_into: number | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * All selectable entity columns (excludes the internal `embedding` vector, which
 * is large and never read back through this mapper — semantic entity resolution
 * scores it in SQL via pgvector `<=>`).
 */
const ENTITY_COLS = `id, type, canonical_name, normalized_name, aliases, slack_user_id,
  email, metadata, confidence, visibility, status, merged_into, source_ref,
  created_at, updated_at`;

function parseAliases(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function mapEntityRow(row: EntityDbRow): EntityRow {
  return {
    id: row.id,
    type: row.type,
    canonicalName: row.canonical_name,
    normalizedName: row.normalized_name,
    aliases: parseAliases(row.aliases),
    slackUserId: row.slack_user_id,
    email: row.email,
    metadata: row.metadata ? safeJson(row.metadata) : null,
    confidence: row.confidence,
    visibility: row.visibility,
    status: row.status,
    mergedInto: row.merged_into,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface CreateEntityInput {
  type: EntityType;
  canonicalName: string;
  slackUserId?: string;
  email?: string;
  confidence?: number;
  visibility?: string;
  metadata?: Record<string, unknown>;
  sourceRef?: string;
  aliases?: string[];
  now?: Date;
}

/** Inserts a new entity. The caller is responsible for resolving first. */
export async function createEntity(q: Queryable, input: CreateEntityInput): Promise<EntityRow> {
  const now = (input.now ?? new Date()).toISOString();
  const row = (await q.query(
    `INSERT INTO entities (
       type, canonical_name, normalized_name, aliases, slack_user_id, email,
       metadata, confidence, visibility, status, source_ref, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $11, $12)
     RETURNING ${ENTITY_COLS}`,
    [
      input.type,
      input.canonicalName,
      normalizeForHash(input.canonicalName),
      JSON.stringify(input.aliases ?? []),
      input.slackUserId ?? null,
      input.email ? input.email.toLowerCase() : null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      input.confidence ?? 0.5,
      input.visibility ?? "founders",
      input.sourceRef ?? null,
      now,
      now,
    ]
  )).rows[0] as EntityDbRow;
  return mapEntityRow(row);
}

export async function getEntityById(q: Queryable, id: number): Promise<EntityRow | null> {
  const row = (await q.query(`SELECT ${ENTITY_COLS} FROM entities WHERE id = $1`, [id]))
    .rows[0] as EntityDbRow | undefined;
  return row ? mapEntityRow(row) : null;
}

/**
 * Loads the candidate pool the pure resolver scores against: active entities
 * matching a hard key OR sharing a name/alias substring with the query. The
 * prefilter is permissive (substring) so it never hides a fuzzy match; the
 * resolver does the precise scoring.
 */
export async function getResolutionCandidates(
  q: Queryable,
  input: ResolveInput,
  limit = 50
): Promise<EntityCandidate[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (input.slackUserId) {
    params.push(input.slackUserId);
    clauses.push(`slack_user_id = $${params.length}`);
  }
  if (input.email) {
    params.push(input.email.toLowerCase());
    clauses.push(`email = $${params.length}`);
  }
  const tokens = normalizeForHash(input.rawName).split(" ").filter(Boolean);
  for (const t of tokens) {
    const pattern = `%${t}%`;
    params.push(pattern);
    const nameIdx = params.length;
    params.push(pattern);
    const aliasIdx = params.length;
    clauses.push(`(normalized_name ILIKE $${nameIdx} OR aliases ILIKE $${aliasIdx})`);
  }
  if (clauses.length === 0) return [];

  params.push(limit);
  const rows = (await q.query(
    `SELECT ${ENTITY_COLS} FROM entities
     WHERE status = 'active' AND (${clauses.join(" OR ")})
     ORDER BY updated_at DESC, id DESC
     LIMIT $${params.length}`,
    params
  )).rows as EntityDbRow[];

  return rows.map((r) => {
    const e = mapEntityRow(r);
    return {
      id: e.id,
      type: e.type,
      canonicalName: e.canonicalName,
      normalizedName: e.normalizedName,
      aliases: e.aliases,
      slackUserId: e.slackUserId,
      email: e.email,
    };
  });
}

export interface MentionedEntity {
  entityId: number;
  name: string;
  type: EntityType;
}

/**
 * Finds active entities mentioned in a free-text query: an entity is mentioned
 * when ALL tokens of its canonical name (or an alias) appear in the query.
 * Single-token names must be ≥5 chars to qualify, filtering generic words
 * ("team", "ops") that would otherwise match every query. Ranked by match
 * span (longer names first), then confidence.
 */
export async function resolveQueryEntities(
  q: Queryable,
  query: string,
  limit = 3
): Promise<MentionedEntity[]> {
  const qTokens = tokenSet(normalizeForHash(query));
  if (qTokens.size === 0) return [];

  const candidates = await getResolutionCandidates(q, { rawName: query }, 100);

  const qualifies = (norm: string): number => {
    const t = [...tokenSet(norm)];
    if (t.length === 0) return 0;
    if (!t.every((tok) => qTokens.has(tok))) return 0;
    if (t.length === 1 && t[0].length < 5) return 0; // drop generic single tokens
    return t.length; // span = match strength
  };

  const scored = candidates
    .map((c) => {
      const nameSpan = qualifies(c.normalizedName);
      const aliasSpan = Math.max(0, ...c.aliases.map((a) => qualifies(a)), 0);
      return { c, span: Math.max(nameSpan, aliasSpan) };
    })
    .filter((s) => s.span > 0)
    .sort((a, b) => b.span - a.span);

  return scored.slice(0, limit).map((s) => ({
    entityId: s.c.id,
    name: s.c.canonicalName,
    type: s.c.type,
  }));
}

/**
 * Sets a missing hard key (COALESCE keeps an existing one). Throws on a
 * partial-unique collision — the signal to merge two entities sharing a key.
 */
export async function attachIdentity(
  q: Queryable,
  id: number,
  keys: { slackUserId?: string; email?: string },
  now: Date = new Date()
): Promise<void> {
  await q.query(
    `UPDATE entities
       SET slack_user_id = COALESCE(slack_user_id, $1),
           email = COALESCE(email, $2),
           updated_at = $3
     WHERE id = $4`,
    [
      keys.slackUserId ?? null,
      keys.email ? keys.email.toLowerCase() : null,
      now.toISOString(),
      id,
    ]
  );
}

/** Appends a normalized alias if not already present (idempotent). */
export async function addAlias(
  q: Queryable,
  id: number,
  alias: string,
  now: Date = new Date()
): Promise<void> {
  const norm = normalizeForHash(alias);
  if (!norm) return;
  const row = (await q.query(`SELECT aliases FROM entities WHERE id = $1`, [id]))
    .rows[0] as { aliases: string | null } | undefined;
  if (!row) return;
  const aliases = parseAliases(row.aliases);
  if (aliases.includes(norm)) return;
  aliases.push(norm);
  await q.query(`UPDATE entities SET aliases = $1, updated_at = $2 WHERE id = $3`, [
    JSON.stringify(aliases),
    now.toISOString(),
    id,
  ]);
}

export interface LinkMemoryEntityInput {
  memoryId: number;
  entityId: number;
  role?: MemoryEntityRole;
  confidence?: number;
  now?: Date;
}

/** Links a memory to an entity. Exact (memory, entity, role) dups are ignored. */
export async function linkMemoryEntity(q: Queryable, link: LinkMemoryEntityInput): Promise<void> {
  await q.query(
    `INSERT INTO memory_entities (memory_id, entity_id, role, confidence, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (memory_id, entity_id, role) DO NOTHING`,
    [
      link.memoryId,
      link.entityId,
      link.role ?? "mention",
      link.confidence ?? 0.5,
      (link.now ?? new Date()).toISOString(),
    ]
  );
}

export interface EntityProfileRow {
  entityId: number;
  profileMd: string;
  sourceFactIds: number[];
  factCount: number;
  version: number;
  model: string;
  builtAt: string;
  updatedAt: string;
}

/** Count of distinct ACTIVE memories linked to an entity. */
export async function getEntityActiveFactCount(q: Queryable, entityId: number): Promise<number> {
  const row = (await q.query(
    `SELECT COUNT(DISTINCT me.memory_id) AS n
     FROM memory_entities me
     JOIN memories m ON m.id = me.memory_id
     WHERE me.entity_id = $1 AND m.status = 'active'`,
    [entityId]
  )).rows[0] as { n: number | string };
  // COUNT() returns bigint, which pg yields as a string — normalize to number.
  return Number(row.n);
}

export async function getEntityProfile(q: Queryable, entityId: number): Promise<EntityProfileRow | null> {
  const row = (await q.query(
    `SELECT entity_id, profile_md, source_fact_ids, fact_count, version, model, built_at, updated_at
     FROM entity_profiles WHERE entity_id = $1`,
    [entityId]
  )).rows[0] as
    | {
        entity_id: number;
        profile_md: string;
        source_fact_ids: string;
        fact_count: number;
        version: number;
        model: string;
        built_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  let sourceFactIds: number[] = [];
  try {
    const v = JSON.parse(row.source_fact_ids);
    if (Array.isArray(v)) sourceFactIds = v.filter((x) => typeof x === "number");
  } catch {
    /* tolerate malformed */
  }
  return {
    entityId: row.entity_id,
    profileMd: row.profile_md,
    sourceFactIds,
    factCount: row.fact_count,
    version: row.version,
    model: row.model,
    builtAt: row.built_at,
    updatedAt: row.updated_at,
  };
}

/** The fact count at the last consolidation, for delta-based due detection. */
export async function getProfileCursor(q: Queryable, entityId: number): Promise<number> {
  const row = (await q.query(
    `SELECT last_fact_count FROM entity_profile_cursors WHERE entity_id = $1`,
    [entityId]
  )).rows[0] as { last_fact_count: number } | undefined;
  return row?.last_fact_count ?? 0;
}

export interface UpsertProfileInput {
  entityId: number;
  profileMd: string;
  sourceFactIds: number[];
  /** Total active linked fact count at build time (drives the rebuild delta). */
  factCount: number;
  model: string;
  now?: Date;
}

/**
 * Upserts an entity's dossier and refreshes its consolidation cursor in one
 * transaction. On rebuild, version increments and built_at/updated_at advance.
 */
export async function upsertEntityProfile(pool: DbPool, input: UpsertProfileInput): Promise<number> {
  const ts = (input.now ?? new Date()).toISOString();
  return withTxOn(pool, async (client): Promise<number> => {
    const row = (await client.query(
      `INSERT INTO entity_profiles (
         entity_id, profile_md, source_fact_ids, fact_count, version, model, built_at, updated_at
       ) VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
       ON CONFLICT (entity_id) DO UPDATE SET
         profile_md = EXCLUDED.profile_md,
         source_fact_ids = EXCLUDED.source_fact_ids,
         fact_count = EXCLUDED.fact_count,
         version = entity_profiles.version + 1,
         model = EXCLUDED.model,
         built_at = EXCLUDED.built_at,
         updated_at = EXCLUDED.updated_at
       RETURNING version`,
      [
        input.entityId,
        input.profileMd,
        JSON.stringify(input.sourceFactIds),
        input.factCount,
        input.model,
        ts,
        ts,
      ]
    )).rows[0] as { version: number };

    await client.query(
      `INSERT INTO entity_profile_cursors (entity_id, last_fact_count)
       VALUES ($1, $2)
       ON CONFLICT (entity_id) DO UPDATE SET last_fact_count = EXCLUDED.last_fact_count`,
      [input.entityId, input.factCount]
    );

    return row.version;
  });
}

/**
 * Right-to-be-forgotten: redacts (forgets) every ACTIVE memory tied to
 * `entityId`. Returns the count forgotten. Pair with {@link addEntityExclusion}
 * so future facts about the entity are dropped.
 *
 * Subject-attribution alone is NOT enough: a fact can name a person in its text
 * yet carry no `subject_entity_id` (resolution never cleared the floor) and no
 * join-table link, leaving the forgotten name FTS-searchable. So three sources
 * are unioned:
 *  1. governance subject (`subject_entity_id`),
 *  2. any `memory_entities` link (subject/owner/mention/about),
 *  3. the entity's canonical name or an alias appearing verbatim in the fact
 *     text (normalized substring).
 *
 * (3) is gated to phrases of ≥2 tokens so a generic single-token entity name
 * ("Drive", "App") can't collide with unrelated facts. Forgetting is reversible
 * (a `forgotten` tombstone, not a delete), so over-redacting an incidental
 * mention is the safe failure mode — it under-shares, never widens exposure.
 */
export async function forgetEntityMemories(
  q: Queryable,
  entityId: number,
  now: Date = new Date()
): Promise<number> {
  const ids = new Set<number>();

  // (1) governance subject
  for (const r of (await q.query(
    `SELECT id FROM memories WHERE subject_entity_id = $1 AND status = 'active'`,
    [entityId]
  )).rows as Array<{ id: number }>) {
    ids.add(r.id);
  }

  // (2) any join-table link to this entity
  for (const r of (await q.query(
    `SELECT m.id AS id FROM memories m
     JOIN memory_entities me ON me.memory_id = m.id
     WHERE me.entity_id = $1 AND m.status = 'active'`,
    [entityId]
  )).rows as Array<{ id: number }>) {
    ids.add(r.id);
  }

  // (3) name/alias appearing verbatim in active fact text (the keyword leak).
  const entity = await getEntityById(q, entityId);
  if (entity) {
    const phrases = [entity.canonicalName, ...entity.aliases]
      .map((p) => normalizeForHash(p))
      .filter((p) => p.split(" ").filter(Boolean).length >= 2);
    if (phrases.length > 0) {
      for (const r of (await q.query(
        `SELECT id, text FROM memories WHERE status = 'active'`
      )).rows as Array<{ id: number; text: string }>) {
        const norm = normalizeForHash(r.text);
        if (phrases.some((p) => norm.includes(p))) ids.add(r.id);
      }
    }
  }

  if (ids.size === 0) return 0;
  const list = [...ids];
  const r = await q.query(
    `UPDATE memories SET status = 'forgotten', updated_at = $1
     WHERE id = ANY($2) AND status = 'active'`,
    [now.toISOString(), list]
  );
  return r.rowCount ?? 0;
}

/** Records (or refreshes) a do-not-store exclusion for an entity. */
export async function addEntityExclusion(
  q: Queryable,
  entityId: number,
  reason?: string,
  createdBy?: string,
  now: Date = new Date()
): Promise<void> {
  await q.query(
    `INSERT INTO entity_exclusions (entity_id, reason, created_by, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (entity_id) DO UPDATE SET
       reason = EXCLUDED.reason, created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
    [entityId, reason ?? null, createdBy ?? null, now.toISOString()]
  );
}

/** True when the entity is on the do-not-store exclusion list. */
export async function isEntityExcluded(q: Queryable, entityId: number): Promise<boolean> {
  const row = (await q.query(`SELECT 1 AS hit FROM entity_exclusions WHERE entity_id = $1`, [entityId]))
    .rows[0];
  return row !== undefined;
}

/** Sets the per-fact governance subject (the one entity a fact is ABOUT). */
export async function setMemorySubject(
  q: Queryable,
  memoryId: number,
  entityId: number | null
): Promise<void> {
  await q.query(`UPDATE memories SET subject_entity_id = $1 WHERE id = $2`, [entityId, memoryId]);
}

/** Distinct memory ids linked to an entity (any role). */
export async function getEntityMemoryIds(q: Queryable, entityId: number): Promise<number[]> {
  const rows = (await q.query(
    `SELECT DISTINCT memory_id FROM memory_entities WHERE entity_id = $1 ORDER BY memory_id`,
    [entityId]
  )).rows as Array<{ memory_id: number }>;
  return rows.map((r) => r.memory_id);
}

export async function getMemoryEntities(
  q: Queryable,
  memoryId: number
): Promise<Array<{ entityId: number; role: MemoryEntityRole; confidence: number }>> {
  const rows = (await q.query(
    `SELECT entity_id, role, confidence FROM memory_entities WHERE memory_id = $1`,
    [memoryId]
  )).rows as Array<{ entity_id: number; role: MemoryEntityRole; confidence: number }>;
  return rows.map((r) => ({ entityId: r.entity_id, role: r.role, confidence: r.confidence }));
}

export interface UpsertEdgeInput {
  srcId: number;
  dstId: number;
  relation: EntityRelation;
  confidence?: number;
  provenance?: string;
  assertedAt?: string;
  now?: Date;
}

/**
 * Upserts a directed edge. On conflict, confidence grows asymptotically toward
 * the cap (persona_traits) OR jumps to a higher incoming confidence, whichever
 * is greater; evidence_count increments; asserted_at advances to the newest;
 * the edge is reactivated. Returns whether a new edge was created.
 */
export async function upsertEdge(q: Queryable, edge: UpsertEdgeInput): Promise<{ id: number; created: boolean }> {
  const now = (edge.now ?? new Date()).toISOString();
  const existing = (await q.query(
    `SELECT id FROM entity_edges WHERE src_id = $1 AND dst_id = $2 AND relation = $3`,
    [edge.srcId, edge.dstId, edge.relation]
  )).rows[0] as { id: number } | undefined;

  const row = (await q.query(
    `INSERT INTO entity_edges (
       src_id, dst_id, relation, confidence, evidence_count, provenance,
       asserted_at, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 1, $5, $6, 'active', $7, $8)
     ON CONFLICT (src_id, dst_id, relation) DO UPDATE SET
       confidence = GREATEST(
         LEAST(entity_edges.confidence + (1 - entity_edges.confidence) * ${EDGE_CONFIDENCE_GROWTH}, ${EDGE_CONFIDENCE_CAP}),
         EXCLUDED.confidence
       ),
       evidence_count = entity_edges.evidence_count + 1,
       provenance = COALESCE(EXCLUDED.provenance, entity_edges.provenance),
       asserted_at = CASE
         WHEN EXCLUDED.asserted_at IS NULL THEN entity_edges.asserted_at
         WHEN entity_edges.asserted_at IS NULL THEN EXCLUDED.asserted_at
         WHEN EXCLUDED.asserted_at > entity_edges.asserted_at THEN EXCLUDED.asserted_at
         ELSE entity_edges.asserted_at END,
       status = 'active',
       updated_at = EXCLUDED.updated_at
     RETURNING id`,
    [
      edge.srcId,
      edge.dstId,
      edge.relation,
      edge.confidence ?? 0.5,
      edge.provenance ?? null,
      edge.assertedAt ?? null,
      now,
      now,
    ]
  )).rows[0] as { id: number };

  return { id: row.id, created: existing === undefined };
}

/**
 * Withdraws one fact's support for an edge. Decrements `evidence_count`; when it
 * reaches zero the edge has no surviving evidence, so it is retired
 * (`status='superseded'`) and drops out of the active-only org queries. The
 * inverse of {@link upsertEdge}'s increment — used when a fact is superseded or
 * forgotten so a corrected ownership/role doesn't keep pointing at stale data.
 * Returns 1 if an active edge was touched, else 0.
 */
export async function retractEdge(
  q: Queryable,
  srcId: number,
  dstId: number,
  relation: EntityRelation,
  now: Date = new Date()
): Promise<number> {
  const existing = (await q.query(
    `SELECT id, evidence_count FROM entity_edges
     WHERE src_id = $1 AND dst_id = $2 AND relation = $3 AND status = 'active'`,
    [srcId, dstId, relation]
  )).rows[0] as { id: number; evidence_count: number } | undefined;
  if (!existing) return 0;

  if (existing.evidence_count <= 1) {
    await q.query(
      `UPDATE entity_edges SET evidence_count = 0, status = 'superseded', updated_at = $1 WHERE id = $2`,
      [now.toISOString(), existing.id]
    );
  } else {
    await q.query(
      `UPDATE entity_edges SET evidence_count = evidence_count - 1, updated_at = $1 WHERE id = $2`,
      [now.toISOString(), existing.id]
    );
  }
  return 1;
}

interface EdgeDbRow {
  id: number;
  src_id: number;
  dst_id: number;
  relation: EntityRelation;
  confidence: number;
  evidence_count: number;
  provenance: string | null;
  asserted_at: string | null;
  status: EntityEdgeRow["status"];
  created_at: string;
  updated_at: string;
}

function mapEdgeRow(r: EdgeDbRow): EntityEdgeRow {
  return {
    id: r.id,
    srcId: r.src_id,
    dstId: r.dst_id,
    relation: r.relation,
    confidence: r.confidence,
    evidenceCount: r.evidence_count,
    provenance: r.provenance,
    assertedAt: r.asserted_at,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface EdgeFilter {
  srcId?: number;
  dstId?: number;
  relation?: EntityRelation;
  status?: EntityEdgeRow["status"];
}

export interface EntityRef {
  entityId: number;
  name: string;
  type: EntityType;
}

/**
 * Team roster from the edge graph: the lead (a `manages` edge into the team)
 * and members (`member_of` edges into the team), filtered to edges whose
 * read-time-decayed confidence clears the display threshold.
 */
export async function getTeamRoster(
  q: Queryable,
  teamId: number,
  now: Date = new Date()
): Promise<{ lead: EntityRef | null; members: EntityRef[] }> {
  const display = (e: EntityEdgeRow) =>
    decayedEdgeConfidence(e.confidence, e.updatedAt, now) >= EDGE_DISPLAY_THRESHOLD;
  const toRef = async (id: number): Promise<EntityRef | null> => {
    const e = await getEntityById(q, id);
    return e ? { entityId: e.id, name: e.canonicalName, type: e.type } : null;
  };

  const leadEdges = (await getEdges(q, { dstId: teamId, relation: "manages", status: "active" })).filter(display);
  let leadRef: EntityRef | null = null;
  for (const e of leadEdges) {
    const ref = await toRef(e.srcId);
    if (ref !== null) {
      leadRef = ref;
      break;
    }
  }

  const memberEdges = (await getEdges(q, { dstId: teamId, relation: "member_of", status: "active" })).filter(display);
  const members: EntityRef[] = [];
  for (const e of memberEdges) {
    const ref = await toRef(e.srcId);
    if (ref !== null) members.push(ref);
  }

  return { lead: leadRef, members };
}

/**
 * Entities reachable from `srcId` via an outgoing edge of `relation`, filtered
 * by decayed confidence. Used by org_lookup / "who owns X" tools.
 */
export async function getRelatedEntities(
  q: Queryable,
  srcId: number,
  relation: EntityRelation,
  now: Date = new Date()
): Promise<Array<EntityRef & { confidence: number }>> {
  const out: Array<EntityRef & { confidence: number }> = [];
  for (const e of await getEdges(q, { srcId, relation, status: "active" })) {
    const dc = decayedEdgeConfidence(e.confidence, e.updatedAt, now);
    if (dc < EDGE_DISPLAY_THRESHOLD) continue;
    const ent = await getEntityById(q, e.dstId);
    if (ent) out.push({ entityId: ent.id, name: ent.canonicalName, type: ent.type, confidence: dc });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

export async function getEdges(q: Queryable, filter: EdgeFilter = {}): Promise<EntityEdgeRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.srcId !== undefined) { params.push(filter.srcId); clauses.push(`src_id = $${params.length}`); }
  if (filter.dstId !== undefined) { params.push(filter.dstId); clauses.push(`dst_id = $${params.length}`); }
  if (filter.relation !== undefined) { params.push(filter.relation); clauses.push(`relation = $${params.length}`); }
  if (filter.status !== undefined) { params.push(filter.status); clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = (await q.query(
    `SELECT * FROM entity_edges ${where} ORDER BY id`,
    params
  )).rows as EdgeDbRow[];
  return rows.map(mapEdgeRow);
}

/**
 * Merges `loserId` into `winnerId` (the supersede pattern, atomically):
 *  - re-points memory_entities links (dedup on the composite PK),
 *  - folds entity_edges into the winner (MAX confidence, summed evidence),
 *  - unions aliases (+ the loser's canonical name),
 *  - copies hard keys the winner lacks,
 *  - tombstones the loser (status='merged', merged_into).
 * The loser is tombstoned BEFORE its keys are copied so the active partial-
 * unique indexes never transiently collide.
 */
export async function mergeEntities(
  pool: DbPool,
  loserId: number,
  winnerId: number,
  now: Date = new Date()
): Promise<void> {
  if (loserId === winnerId) {
    throw new Error("mergeEntities: cannot merge an entity into itself");
  }
  const ts = now.toISOString();

  await withTxOn(pool, async (client) => {
    await client.query("SET CONSTRAINTS ALL DEFERRED");

    const loser = await getEntityById(client, loserId);
    const winner = await getEntityById(client, winnerId);
    if (!loser) throw new Error(`mergeEntities: loser ${loserId} not found`);
    if (!winner) throw new Error(`mergeEntities: winner ${winnerId} not found`);

    // 1. Re-point memory links (ignore PK collisions), then drop loser links.
    await client.query(
      `INSERT INTO memory_entities (memory_id, entity_id, role, confidence, created_at)
       SELECT memory_id, $1, role, confidence, created_at FROM memory_entities WHERE entity_id = $2
       ON CONFLICT (memory_id, entity_id, role) DO NOTHING`,
      [winnerId, loserId]
    );
    await client.query(`DELETE FROM memory_entities WHERE entity_id = $1`, [loserId]);

    // 2. Fold edges. For each loser edge, compute its winner-equivalent and
    // either fold into an existing winner edge or re-point the loser edge.
    const loserEdges = (await getEdges(client, { srcId: loserId })).concat(
      await getEdges(client, { dstId: loserId })
    );
    for (const e of loserEdges) {
      const newSrc = e.srcId === loserId ? winnerId : e.srcId;
      const newDst = e.dstId === loserId ? winnerId : e.dstId;
      // Drop self-loops the merge would create (e.g. loser→winner edges).
      if (newSrc === newDst) {
        await client.query(`DELETE FROM entity_edges WHERE id = $1`, [e.id]);
        continue;
      }
      const target = (await client.query(
        `SELECT id, confidence, evidence_count FROM entity_edges WHERE src_id = $1 AND dst_id = $2 AND relation = $3`,
        [newSrc, newDst, e.relation]
      )).rows[0] as { id: number; confidence: number; evidence_count: number } | undefined;
      if (target && target.id !== e.id) {
        await client.query(
          `UPDATE entity_edges
             SET confidence = GREATEST(confidence, $1),
                 evidence_count = evidence_count + $2,
                 updated_at = $3
           WHERE id = $4`,
          [e.confidence, e.evidenceCount, ts, target.id]
        );
        await client.query(`DELETE FROM entity_edges WHERE id = $1`, [e.id]);
      } else {
        await client.query(`UPDATE entity_edges SET src_id = $1, dst_id = $2, updated_at = $3 WHERE id = $4`, [
          newSrc,
          newDst,
          ts,
          e.id,
        ]);
      }
    }

    // 3. Tombstone the loser FIRST (frees its hard keys from the active set).
    await client.query(`UPDATE entities SET status = 'merged', merged_into = $1, updated_at = $2 WHERE id = $3`, [
      winnerId,
      ts,
      loserId,
    ]);

    // 4. Union aliases (winner ∪ loser aliases ∪ loser canonical) + copy keys.
    const mergedAliases = new Set<string>(winner.aliases);
    for (const a of loser.aliases) mergedAliases.add(a);
    mergedAliases.add(loser.normalizedName);
    mergedAliases.delete(winner.normalizedName); // winner's own name isn't an alias
    await client.query(
      `UPDATE entities
         SET aliases = $1,
             slack_user_id = COALESCE(slack_user_id, $2),
             email = COALESCE(email, $3),
             confidence = GREATEST(confidence, $4),
             updated_at = $5
       WHERE id = $6`,
      [
        JSON.stringify([...mergedAliases]),
        loser.slackUserId,
        loser.email,
        loser.confidence,
        ts,
        winnerId,
      ]
    );
  });
}
