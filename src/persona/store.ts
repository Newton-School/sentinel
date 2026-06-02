import { getDb } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import type { PersonaProfile, PersonaTrait } from "./types.js";
import { decayedConfidence } from "./personaDecay.js";

const log = createLogger("persona-store");

// Raw row shapes as returned by SQLite (snake_case columns).
interface PersonaRow {
  user_id: string;
  display_name: string;
  role: string | null;
  created_at: string;
  updated_at: string;
}

interface PersonaTraitRow {
  id: number;
  user_id: string;
  label: string;
  value: string;
  confidence: number;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

function mapPersonaRow(row: PersonaRow): PersonaProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTraitRow(row: PersonaTraitRow): PersonaTrait {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    value: row.value,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrCreatePersona(
  userId: string,
  displayName: string
): PersonaProfile {
  const db = getDb();
  const now = new Date().toISOString();

  // Idempotent upsert: guarantees a row exists without ever throwing on a
  // concurrent/duplicate first-time insert (personas.user_id is the PK).
  // DO NOTHING preserves an existing row's display_name/role/timestamps.
  db.prepare(
    `INSERT INTO personas (user_id, display_name, role, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`
  ).run(userId, displayName, now, now);

  // Always read back through the mapping layer so we return the canonical
  // row (which, on conflict, is the pre-existing one — not our values).
  const row = db
    .prepare("SELECT * FROM personas WHERE user_id = ?")
    .get(userId) as PersonaRow;

  log.info({ userId, displayName }, "Fetched/created persona");
  return mapPersonaRow(row);
}

export function getTraits(userId: string): PersonaTrait[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT * FROM persona_traits WHERE user_id = ? ORDER BY confidence DESC"
    )
    .all(userId) as PersonaTraitRow[];
  return rows.map(mapTraitRow);
}

/**
 * Returns traits with a READ-TIME confidence decay applied (see
 * `decayedConfidence`). Stored rows are never mutated; the returned objects
 * carry the faded confidence so stale interests down-weight without a write.
 * Results are re-sorted by the decayed confidence (descending).
 *
 * `now` is injectable for deterministic tests; defaults to the current time.
 */
export function getTraitsForPrompt(
  userId: string,
  now: Date = new Date()
): PersonaTrait[] {
  return getTraits(userId)
    .map((trait) => ({
      ...trait,
      confidence: decayedConfidence(trait.confidence, trait.updatedAt, now),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export function upsertTrait(
  userId: string,
  label: string,
  value: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  // Single-statement upsert keyed on UNIQUE(user_id, label, value).
  // First insert seeds confidence 0.5 / evidence_count 1. On conflict the
  // existing row is updated: confidence grows asymptotically toward the 0.95
  // ceiling by + (1 - confidence) * 0.15, and evidence_count is incremented.
  // Bare confidence/evidence_count in the DO UPDATE refer to the existing
  // row's values; MIN is SQLite's scalar min. This never throws on a
  // duplicate insert, making it race-safe.
  db.prepare(
    `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
     VALUES (?, ?, ?, 0.5, 1, ?, ?)
     ON CONFLICT(user_id, label, value) DO UPDATE SET
       confidence = MIN(confidence + (1 - confidence) * 0.15, 0.95),
       evidence_count = evidence_count + 1,
       updated_at = excluded.updated_at`
  ).run(userId, label, value, now, now);

  log.debug({ userId, label, value }, "Upserted trait");
}
