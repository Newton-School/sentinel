/**
 * Bridges extracted facts to the entity graph: resolves each free-text entity
 * name a fact mentions to an entity (creating one when gated), writes the
 * `memory_entities` links, and sets the fact's governance subject.
 *
 * Runs downstream of the hardened extractor — it never touches extraction.
 * Takes a `db` handle (testable like the SQL layer); the getDb-bound entry
 * point is `memoryStore.insertFact`, which calls this opportunistically when
 * the entity graph is enabled.
 *
 * Privacy/anti-fragmentation rules (see Phase A design):
 *  - A name is linked only when it resolves confidently or is creation-gated;
 *    ambiguous names are dropped (a missing link beats a wrong attribution).
 *  - `subject_entity_id` is set only when attribution clears
 *    MEMORY_ENTITY_RESOLVE_MIN, so a resolution error can never WIDEN
 *    visibility — only fail to narrow.
 */

import type Database from "better-sqlite3";
import type { MemoryCategory, MemorySourceType, NewFact } from "./types.js";
import { recordEntityResolution } from "../metrics/registry.js";
import {
  resolveEntity,
  type EntityType,
} from "./entityResolve.js";
import {
  addAlias,
  createEntity,
  getEntityById,
  getMemoryEntities,
  getResolutionCandidates,
  isEntityExcluded,
  linkMemoryEntity,
  retractEdge,
  setMemorySubject,
  upsertEdge,
  type MemoryEntityRole,
} from "./entitySql.js";
import { proposeEdgesForFact } from "./orgInfer.js";
import { forgetMemory } from "./memorySql.js";

/** Default confidence floor for setting subject_entity_id (privacy-safe). */
export const DEFAULT_RESOLVE_MIN = 0.8;

/** True when fact→entity linking should run (runtime kill switch, default off). */
export function isEntityGraphEnabled(): boolean {
  return process.env.MEMORY_ENTITY_GRAPH === "1";
}

/** Subject-attribution confidence floor, overridable at runtime. */
export function resolveMin(): number {
  const raw = Number(process.env.MEMORY_ENTITY_RESOLVE_MIN);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_RESOLVE_MIN;
}

const TEAM_NAME = /\b(teams?|squads?|pods?|guilds?|councils?|orgs?|departments?|depts?)\b/i;
const PROJECT_NAME =
  /\b(project|projects|revamp|migration|launch|initiative|rollout|playbook|pipeline|funnel|roadmap|redesign|overhaul|integration|epic|program|programme|workstream|effort)\b/i;
const METRIC_NAME =
  /\b(target|targets|rate|nps|csat|revenue|arr|mrr|churn|retention|conversion|metric|metrics|kpi|kpis|ratio|score|throughput|latency|uptime|ctc)\b|%/i;
const PRODUCT_NAME =
  /\b(app|apps|platform|product|dashboard|portal|sdk|api|website|extension|widget)\b/i;

/**
 * Heuristic type for a freshly-seen entity name when the LLM didn't supply one.
 * Checks team → project → metric → product patterns, else defaults to person
 * (the dominant org entity). Misclassifications only affect newly-CREATED
 * entities and are correctable via merge.
 */
export function guessEntityType(rawName: string): EntityType {
  if (TEAM_NAME.test(rawName)) return "team";
  if (PROJECT_NAME.test(rawName)) return "project";
  if (METRIC_NAME.test(rawName)) return "metric";
  if (PRODUCT_NAME.test(rawName)) return "product";
  return "person";
}

export interface LinkResult {
  /** Number of distinct entities linked to the memory. */
  linked: number;
  /** The chosen governance subject, or null when none cleared the floor. */
  subjectEntityId: number | null;
  /** True when the fact was forgotten because its subject is an excluded entity. */
  forgotten?: boolean;
}

/**
 * Resolves and links the entities a fact mentions. Idempotent on re-run
 * (link inserts dedupe on the composite PK; subject set is overwrite-safe).
 */
export function linkFactEntities(
  db: Database.Database,
  memoryId: number,
  fact: NewFact,
  now: Date = new Date()
): LinkResult {
  const names = (fact.entities ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return { linked: 0, subjectEntityId: null };

  const subjectRole: MemoryEntityRole = fact.category === "owner" ? "owner" : "subject";
  const minSubject = resolveMin();

  // Resolve every named entity FIRST (tracking exclusion), so we can tell
  // whether the fact's PRIMARY subject is a forgotten entity before linking.
  interface Resolved {
    id: number;
    conf: number;
    type: EntityType;
    excluded: boolean;
    alias?: string;
    /** True unless resolved via a fuzzy (least-certain) match. */
    cleanForSubject: boolean;
  }
  const resolvedById = new Map<number, Resolved>();
  // Maps a normalized entity name to the entity it resolved to, so an
  // extractor-declared `subject` name can be located among the resolved set.
  const nameToId = new Map<string, number>();

  for (const rawName of names) {
    const hint = guessEntityType(rawName);
    const candidates = getResolutionCandidates(db, { rawName });
    const decision = resolveEntity({ rawName, type: hint }, candidates);

    let entityId = decision.entityId;
    let entityType = hint;
    if (entityId !== undefined) {
      recordEntityResolution("matched");
      // Use the matched entity's actual type, not the name-guessed hint.
      entityType = candidates.find((c) => c.id === entityId)?.type ?? hint;
    } else if (decision.shouldCreate) {
      entityId = createEntity(db, {
        type: hint,
        canonicalName: rawName,
        confidence: decision.confidence,
        sourceRef: fact.sourceRef,
        now,
      }).id;
      recordEntityResolution("created");
    } else {
      recordEntityResolution("ambiguous");
      continue; // ambiguous / ungated → record nothing
    }

    nameToId.set(rawName.toLowerCase().replace(/\s+/g, " ").trim(), entityId);

    const prev = resolvedById.get(entityId);
    if (prev === undefined || decision.confidence > prev.conf) {
      resolvedById.set(entityId, {
        id: entityId,
        conf: decision.confidence,
        type: entityType,
        excluded: isEntityExcluded(db, entityId),
        alias: decision.match === "fuzzy" ? decision.newAlias : undefined,
        cleanForSubject: decision.match !== "fuzzy",
      });
    }
  }

  // The governance subject. Prefer an extractor-DECLARED subject when it
  // resolved cleanly (not fuzzy) — this is authoritative even for a freshly
  // created entity below the confidence floor, since the floor only guards
  // against fuzzy mis-attribution, not entity novelty. Without it, the
  // confidence-max heuristic mis-attributes a correction ("owned by NEW, not
  // OLD") to the pre-existing OLD entity, which always resolves higher.
  let subject: Resolved | null = null;
  if (fact.subject) {
    const declaredId = nameToId.get(
      fact.subject.toLowerCase().replace(/\s+/g, " ").trim()
    );
    const declared = declaredId !== undefined ? resolvedById.get(declaredId) : undefined;
    // Excluded declared subjects are still selected here so the downstream
    // text-level-forget check fires for them (a fact about a forgotten entity).
    if (declared && declared.cleanForSubject) subject = declared;
  }
  // Fallback (no declared subject, or it didn't resolve cleanly): highest-
  // confidence resolved entity clearing the attribution floor — unchanged.
  if (!subject) {
    for (const r of resolvedById.values()) {
      if (r.conf >= minSubject && (!subject || r.conf > subject.conf)) subject = r;
    }
  }

  // Right-to-be-forgotten (text level): if the fact is ABOUT an excluded entity
  // (it is that entity's subject), forget the whole fact — otherwise its text
  // would stay keyword-searchable even though the entity was forgotten.
  if (subject && subject.excluded) {
    forgetMemory(db, memoryId, now);
    return { linked: 0, subjectEntityId: null, forgotten: true };
  }

  // Link only NON-excluded entities. An excluded entity that is merely a minor
  // mention (not the subject) is skipped, but the fact itself stays.
  let linked = 0;
  for (const r of resolvedById.values()) {
    if (r.excluded) continue;
    if (r.alias) addAlias(db, r.id, r.alias, now);
    const role: MemoryEntityRole = subject && r.id === subject.id ? subjectRole : "mention";
    linkMemoryEntity(db, { memoryId, entityId: r.id, role, confidence: r.conf, now });
    linked++;
  }
  if (subject) setMemorySubject(db, memoryId, subject.id);

  // Derive org-graph edges (subject is guaranteed non-excluded here). Each fact
  // contributes its signals exactly once (insert OR backfill), so edge
  // confidence never double-counts.
  if (subject) {
    const subjectId = subject.id;
    const others = [...resolvedById.values()]
      .filter((r) => r.id !== subjectId && !r.excluded)
      .map((r) => ({ id: r.id, type: r.type }));
    const proposed = proposeEdgesForFact({
      category: fact.category,
      subject: { id: subjectId, type: subject.type },
      others,
      assertedAt: fact.assertedAt,
    });
    for (const e of proposed) {
      upsertEdge(db, {
        srcId: e.srcId,
        dstId: e.dstId,
        relation: e.relation,
        confidence: e.confidence,
        provenance: e.provenance,
        assertedAt: e.assertedAt,
        now,
      });
    }
  }

  return { linked, subjectEntityId: subject?.id ?? null };
}

/**
 * Withdraws the org-graph edges a single fact contributed when that fact is
 * superseded or forgotten. Reconstructs the fact's edge proposal from its
 * persisted `memory_entities` links (subject = the owner/subject-role link,
 * others = the remaining linked entities) and runs the SAME pure proposer used
 * at link time, then retracts each proposed edge ({@link retractEdge}).
 *
 * Without this, a corrected ownership ("the project is owned by the design
 * team, not Anjali") leaves the stale "Anjali owns" edge active, so org_lookup
 * reports both owners. Idempotent: re-running after the edge is already retired
 * is a no-op (retractEdge only touches active edges). Returns edges retracted.
 */
export function retractFactEdges(
  db: Database.Database,
  memoryId: number,
  now: Date = new Date()
): number {
  const mem = db
    .prepare(`SELECT category, asserted_at FROM memories WHERE id = ?`)
    .get(memoryId) as { category: MemoryCategory; asserted_at: string | null } | undefined;
  if (!mem) return 0;

  const links = getMemoryEntities(db, memoryId);
  const subjectLink = links.find((l) => l.role === "owner" || l.role === "subject");
  if (!subjectLink) return 0;
  const subjectEntity = getEntityById(db, subjectLink.entityId);
  if (!subjectEntity) return 0;

  const otherIds = [...new Set(links.map((l) => l.entityId))].filter(
    (id) => id !== subjectLink.entityId
  );
  const others = otherIds
    .map((id) => getEntityById(db, id))
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .map((e) => ({ id: e.id, type: e.type }));

  const proposed = proposeEdgesForFact({
    category: mem.category,
    subject: { id: subjectEntity.id, type: subjectEntity.type },
    others,
    assertedAt: mem.asserted_at ?? undefined,
  });

  let retracted = 0;
  for (const e of proposed) {
    retracted += retractEdge(db, e.srcId, e.dstId, e.relation, now);
  }
  return retracted;
}

interface BackfillRow {
  id: number;
  text: string;
  category: MemoryCategory;
  entities: string | null;
  source_type: MemorySourceType;
  source_ref: string | null;
}

export interface BackfillResult {
  /** Active, entity-bearing memories examined this run. */
  scanned: number;
  /** Of those, how many produced at least one entity link. */
  linked: number;
  /** Highest memory id examined — pass as `afterId` to drain the next page. */
  maxId: number;
}

/**
 * Re-runnable backfill: resolves+links the free-text `entities` of active
 * memories that still need links. Idempotent (the NOT EXISTS guard skips
 * already-linked rows; resolution dedupes entities, so re-runs don't create
 * duplicates) and bounded by `limit`.
 *
 * Pages by an `afterId` id-cursor (NOT by the link predicate alone): a fact
 * whose names don't resolve to a link (ambiguous / single-token) never gains a
 * link, so a pure NOT-EXISTS drain would re-scan it forever. Advancing the
 * cursor past every examined id guarantees the drain terminates regardless of
 * linking outcome.
 */
export function backfillEntityLinks(
  db: Database.Database,
  opts: { limit?: number; afterId?: number; now?: Date } = {}
): BackfillResult {
  const limit = opts.limit ?? 500;
  const afterId = opts.afterId ?? 0;
  const now = opts.now ?? new Date();
  const rows = db
    .prepare(
      `SELECT id, text, category, entities, source_type, source_ref
       FROM memories m
       WHERE m.status = 'active'
         AND m.entities IS NOT NULL AND m.entities != '[]'
         AND m.id > ?
         AND NOT EXISTS (SELECT 1 FROM memory_entities me WHERE me.memory_id = m.id)
       ORDER BY m.id
       LIMIT ?`
    )
    .all(afterId, limit) as BackfillRow[];

  let linked = 0;
  let maxId = afterId;
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    let entities: string[] = [];
    try {
      const parsed = JSON.parse(r.entities ?? "[]");
      if (Array.isArray(parsed)) entities = parsed.filter((x) => typeof x === "string");
    } catch {
      continue; // malformed entities JSON — skip this row
    }
    const res = linkFactEntities(
      db,
      r.id,
      {
        text: r.text,
        category: r.category,
        entities,
        sourceType: r.source_type,
        sourceRef: r.source_ref ?? undefined,
      },
      now
    );
    if (res.linked > 0) linked++;
  }
  return { scanned: rows.length, linked, maxId };
}
