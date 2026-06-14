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
import type { NewFact } from "./types.js";
import {
  resolveEntity,
  type EntityType,
} from "./entityResolve.js";
import {
  addAlias,
  createEntity,
  getResolutionCandidates,
  linkMemoryEntity,
  setMemorySubject,
  type MemoryEntityRole,
} from "./entitySql.js";

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

  // Dedupe resolved entities by id, keeping the highest decision confidence.
  const byEntity = new Map<number, number>();
  let best: { id: number; conf: number } | null = null;

  for (const rawName of names) {
    const hint = guessEntityType(rawName);
    const candidates = getResolutionCandidates(db, { rawName });
    const decision = resolveEntity({ rawName, type: hint }, candidates);

    let entityId = decision.entityId;
    if (entityId === undefined && decision.shouldCreate) {
      entityId = createEntity(db, {
        type: hint,
        canonicalName: rawName,
        confidence: decision.confidence,
        sourceRef: fact.sourceRef,
        now,
      }).id;
    }
    if (entityId === undefined) continue; // ambiguous / ungated → record nothing

    if (decision.match === "fuzzy" && decision.newAlias) {
      addAlias(db, entityId, decision.newAlias, now);
    }

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

  return { linked: byEntity.size, subjectEntityId: best?.id ?? null };
}
