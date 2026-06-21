import { getPool } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import type { PersonaProfile, PersonaTrait } from "./types.js";
import { decayedConfidence } from "./personaDecay.js";

const log = createLogger("persona-store");

// Raw row shapes as returned by Postgres (snake_case columns).
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

export async function getOrCreatePersona(
  userId: string,
  displayName: string
): Promise<PersonaProfile> {
  const pool = getPool();
  const now = new Date().toISOString();

  // Idempotent upsert: guarantees a row exists without ever throwing on a
  // concurrent/duplicate first-time insert (personas.user_id is the PK).
  // DO NOTHING preserves an existing row's display_name/role/timestamps.
  await pool.query(
    `INSERT INTO personas (user_id, display_name, role, created_at, updated_at)
     VALUES ($1, $2, NULL, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, displayName, now, now]
  );

  // Always read back through the mapping layer so we return the canonical
  // row (which, on conflict, is the pre-existing one — not our values).
  const row = (await pool.query("SELECT * FROM personas WHERE user_id = $1", [userId]))
    .rows[0] as PersonaRow;

  log.info({ userId, displayName }, "Fetched/created persona");
  return mapPersonaRow(row);
}

export async function getTraits(userId: string): Promise<PersonaTrait[]> {
  const pool = getPool();
  const rows = (await pool.query(
    "SELECT * FROM persona_traits WHERE user_id = $1 ORDER BY confidence DESC",
    [userId]
  )).rows as PersonaTraitRow[];
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
export async function getTraitsForPrompt(
  userId: string,
  now: Date = new Date()
): Promise<PersonaTrait[]> {
  return (await getTraits(userId))
    .map((trait) => ({
      ...trait,
      confidence: decayedConfidence(trait.confidence, trait.updatedAt, now),
    }))
    .sort((a, b) => b.confidence - a.confidence);
}

export async function upsertTrait(
  userId: string,
  label: string,
  value: string
): Promise<void> {
  const pool = getPool();
  const now = new Date().toISOString();

  // Single-statement upsert keyed on UNIQUE(user_id, label, value).
  // First insert seeds confidence 0.5 / evidence_count 1. On conflict the
  // existing row is updated: confidence grows asymptotically toward the 0.95
  // ceiling by + (1 - confidence) * 0.15, and evidence_count is incremented.
  // Qualified persona_traits.confidence/evidence_count in the DO UPDATE refer
  // to the existing row's values; LEAST is Postgres's scalar min. This never
  // throws on a duplicate insert, making it race-safe.
  await pool.query(
    `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
     VALUES ($1, $2, $3, 0.5, 1, $4, $5)
     ON CONFLICT (user_id, label, value) DO UPDATE SET
       confidence = LEAST(persona_traits.confidence + (1 - persona_traits.confidence) * 0.15, 0.95),
       evidence_count = persona_traits.evidence_count + 1,
       updated_at = EXCLUDED.updated_at`,
    [userId, label, value, now, now]
  );

  log.debug({ userId, label, value }, "Upserted trait");
}
