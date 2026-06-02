import { getDb } from "../state/db.js";
import { createLogger } from "../logging/logger.js";
import type { PersonaProfile, PersonaTrait } from "./types.js";

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

  const existing = db
    .prepare("SELECT * FROM personas WHERE user_id = ?")
    .get(userId) as PersonaRow | undefined;

  if (existing) return mapPersonaRow(existing);

  log.info({ userId, displayName }, "Creating new persona");
  db.prepare(
    `INSERT INTO personas (user_id, display_name, role, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?)`
  ).run(userId, displayName, now, now);

  return {
    userId,
    displayName,
    role: null,
    createdAt: now,
    updatedAt: now,
  };
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

export function upsertTrait(
  userId: string,
  label: string,
  value: string
): void {
  const db = getDb();
  const now = new Date().toISOString();

  const existingRow = db
    .prepare(
      "SELECT * FROM persona_traits WHERE user_id = ? AND label = ? AND value = ?"
    )
    .get(userId, label, value) as PersonaTraitRow | undefined;
  const existing = existingRow ? mapTraitRow(existingRow) : undefined;

  if (existing) {
    const newConfidence = Math.min(
      existing.confidence + (1 - existing.confidence) * 0.15,
      0.95
    );
    db.prepare(
      `UPDATE persona_traits
       SET confidence = ?, evidence_count = evidence_count + 1, updated_at = ?
       WHERE id = ?`
    ).run(newConfidence, now, existing.id);
    log.debug(
      { userId, label, value, confidence: newConfidence },
      "Updated trait"
    );
  } else {
    db.prepare(
      `INSERT INTO persona_traits (user_id, label, value, confidence, evidence_count, created_at, updated_at)
       VALUES (?, ?, ?, 0.5, 1, ?, ?)`
    ).run(userId, label, value, now, now);
    log.debug({ userId, label, value }, "Created new trait");
  }
}
