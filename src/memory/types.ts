/**
 * Shared types for the persistent organizational memory store.
 *
 * `memorySql.ts` (db-handle-parameterized SQL), `rank.ts` (pure
 * sanitization/ranking) and `memoryStore.ts` (main-process wrappers) all
 * consume these. Keeping them in a standalone module avoids import cycles and
 * lets a future separate-process MCP server share the exact same contracts.
 */

export type MemoryCategory =
  | "decision"
  | "fact"
  | "owner"
  | "deadline"
  | "metric"
  | "preference"
  | "summary";

export type MemorySourceType = "conversation" | "meeting" | "email" | "manual";

export type MemorySensitivity = "normal" | "sensitive";

export type MemoryStatus = "active" | "superseded" | "forgotten";

/** A memory row mapped to camelCase (snake_case columns live in SQLite). */
export interface MemoryRow {
  id: number;
  text: string;
  category: MemoryCategory;
  /** JSON-encoded string array of entity names, or null. */
  entities: string | null;
  sourceType: MemorySourceType;
  sourceRef: string | null;
  sourceLabel: string | null;
  speaker: string | null;
  assertedAt: string | null;
  evidenceQuote: string | null;
  confidence: number;
  verified: boolean;
  visibility: string;
  sensitivity: MemorySensitivity;
  derivedFromMemory: boolean;
  contentHash: string;
  status: MemoryStatus;
  supersededBy: number | null;
  /** Company brain: the single entity this fact is ABOUT (governance subject). */
  subjectEntityId?: number | null;
  /** Company brain: explicit team scope for team-visibility rows. */
  scopeTeamId?: number | null;
  createdAt: string;
  updatedAt: string;
}

/** A search candidate: a memory row plus its bm25 relevance (lower = better). */
export interface MemoryCandidate extends MemoryRow {
  bm: number;
}

/** A ranked memory: candidate plus the final composite score (higher = better). */
export interface RankedMemory extends MemoryCandidate {
  score: number;
}

/** Input shape for inserting a new fact. */
export interface NewFact {
  /** Fact text; hard-capped at 300 chars (longer text is truncated). */
  text: string;
  category: MemoryCategory;
  entities?: string[];
  sourceType: MemorySourceType;
  sourceRef?: string;
  sourceLabel?: string;
  speaker?: string;
  assertedAt?: string;
  evidenceQuote?: string;
  confidence?: number;
  sensitivity?: MemorySensitivity;
  /** Injectable "now" for deterministic tests; defaults to the current time. */
  now?: Date;
}

export interface InsertResult {
  /** True when the fact matched an existing row (hash or near-dup) and reinforced it. */
  deduped: boolean;
  /** Row id of the inserted or reinforced memory. */
  id: number;
}
