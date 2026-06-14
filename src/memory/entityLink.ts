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
  getResolutionCandidates,
  isEntityExcluded,
  linkMemoryEntity,
  setMemorySubject,
  upsertEdge,
  type MemoryEntityRole,
} from "./entitySql.js";
import { proposeEdgesForFact } from "./orgInfer.js";

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

const TEAM_NAME = /\b(teams?|squads?|pods?|groups?|guilds?|councils?|orgs?|departments?|depts?)\b/i;

/**
 * Heuristic type for a freshly-seen entity name. Team-ish names → team;
 * everything else defaults to person (the dominant org entity). Misclassifications
 * are correctable later via merge; this only affects newly-CREATED entities.
 */
export function guessEntityType(rawName: string): EntityType {
  return TEAM_NAME.test(rawName) ? "team" : "person";
}

export interface LinkResult {
  /** Number of distinct entities linked to the memory. */
  linked: number;
  /** The chosen governance subject, or null when none cleared the floor. */
  subjectEntityId: number | null;
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

  // Dedupe resolved entities by id, keeping the highest decision confidence;
  // track each entity's type so org-edge inference can reason about it.
  const byEntity = new Map<number, number>();
  const typeById = new Map<number, EntityType>();
  let best: { id: number; conf: number } | null = null;

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

    // Right-to-be-forgotten: never attribute a fact to an excluded entity.
    if (isEntityExcluded(db, entityId)) continue;

    if (decision.match === "fuzzy" && decision.newAlias) {
      addAlias(db, entityId, decision.newAlias, now);
    }

    typeById.set(entityId, entityType);
    const prev = byEntity.get(entityId);
    if (prev === undefined || decision.confidence > prev) {
      byEntity.set(entityId, decision.confidence);
    }
    if (decision.confidence >= minSubject && (!best || decision.confidence > best.conf)) {
      best = { id: entityId, conf: decision.confidence };
    }
  }

  for (const [entityId, conf] of byEntity) {
    const role: MemoryEntityRole = best && entityId === best.id ? subjectRole : "mention";
    linkMemoryEntity(db, { memoryId, entityId, role, confidence: conf, now });
  }
  if (best) setMemorySubject(db, memoryId, best.id);

  // Derive org-graph edges from this fact (high-precision: owner facts with a
  // confident subject only). Each fact contributes its signals exactly once —
  // at insert OR via backfill (the backfill's NOT-EXISTS guard prevents both),
  // so edge confidence never double-counts.
  if (best) {
    const others = [...byEntity.keys()]
      .filter((id) => id !== best!.id)
      .map((id) => ({ id, type: typeById.get(id) ?? "other" as EntityType }));
    const proposed = proposeEdgesForFact({
      category: fact.category,
      subject: { id: best.id, type: typeById.get(best.id) ?? "person" },
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

  return { linked: byEntity.size, subjectEntityId: best?.id ?? null };
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
