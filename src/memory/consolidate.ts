/**
 * Consolidation: rolls an entity's many facts into one compact dossier
 * (`entity_profiles`). The "store a lot, inject a little" mechanism — a single
 * dossier line replaces dozens of raw facts at injection time (Phase C2).
 *
 * Synthesis goes through the shared `extractJson` Haiku client, so it shares
 * the daily-call budget + redaction path. Sensitive facts are EXCLUDED from
 * the synthesis input (never folded into a non-sensitive summary); the cursor
 * still tracks the total active fact count so new facts (sensitive or not)
 * eventually trigger a rebuild.
 */

import { createLogger } from "../logging/logger.js";
import type { DbPool, Queryable } from "../state/db.js";
import {
  extractJson,
  OPENAI_EXTRACT_MODEL,
  OPENAI_CONSOLIDATION_MODEL,
} from "../llm/openaiClient.js";
import { consolidationSystem } from "../prompts/consolidation.js";
import { activePromptVersionId } from "../prompts/registry.js";
import { getEntityMemoryIds, getEntityById, upsertEntityProfile } from "./entitySql.js";
import { getMemoriesByIds } from "./memorySql.js";

const log = createLogger("consolidate");

/** New linked facts since the last build that trigger a rebuild. */
export const REBUILD_FACT_DELTA = 8;
/** A profile older than this (with ≥1 new fact) is rebuilt for freshness. */
export const REBUILD_MAX_AGE_DAYS = 14;
/** Don't build a dossier for an entity with fewer than this many facts. */
export const MIN_FACTS_FOR_PROFILE = 3;
/** Per-tick consolidation cap (bounds LLM-budget spend per run). */
export const MAX_CONSOLIDATIONS_PER_TICK = 3;
/** Hard cap on stored dossier length. */
export const MAX_PROFILE_CHARS = 1200;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    profile_md: { type: "string" },
    key_fact_ids: { type: "array", items: { type: "number" } },
  },
  required: ["profile_md"],
  additionalProperties: false,
} as const;

export interface ConsolidateDeps {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 'sonnet' for high-value root entities; defaults to Haiku. */
  model?: "haiku" | "sonnet";
}

interface DueDbRow {
  id: number;
  // COUNT(DISTINCT ...) returns bigint, which pg yields as a string.
  fc: number | string;
  last: number;
  built_at: string | null;
}

interface DueRow {
  id: number;
  fc: number;
  last: number;
  built_at: string | null;
}

/**
 * Entities due for (re)consolidation, most-stale-first, capped at `max`:
 *  - never built: due once it has ≥ MIN_FACTS_FOR_PROFILE active facts;
 *  - built: due when ≥ REBUILD_FACT_DELTA new facts accrued, or the profile is
 *    older than REBUILD_MAX_AGE_DAYS and at least one new fact exists.
 */
export async function selectEntitiesDueForConsolidation(
  q: Queryable,
  nowMs: number,
  max = MAX_CONSOLIDATIONS_PER_TICK
): Promise<number[]> {
  const dbRows = (await q.query(
    `SELECT e.id AS id,
            COUNT(DISTINCT me.memory_id) AS fc,
            COALESCE(c.last_fact_count, 0) AS last,
            p.built_at AS built_at
     FROM entities e
     JOIN memory_entities me ON me.entity_id = e.id
     JOIN memories m ON m.id = me.memory_id AND m.status = 'active'
     LEFT JOIN entity_profile_cursors c ON c.entity_id = e.id
     LEFT JOIN entity_profiles p ON p.entity_id = e.id
     WHERE e.status = 'active'
     -- c and p are 1:1 on entity_id, so grouping by their columns keeps one row
     -- per entity; Postgres (unlike SQLite) requires them in GROUP BY here.
     GROUP BY e.id, c.last_fact_count, p.built_at`
  )).rows as DueDbRow[];

  // COUNT() returns bigint (a string from pg) — normalize to number.
  const rows: DueRow[] = dbRows.map((r) => ({
    id: r.id,
    fc: Number(r.fc),
    last: r.last,
    built_at: r.built_at,
  }));

  const ageCutoff = new Date(nowMs - REBUILD_MAX_AGE_DAYS * 86_400_000).toISOString();

  const due = rows.filter((r) => {
    if (r.built_at === null) return r.fc >= MIN_FACTS_FOR_PROFILE;
    if (r.fc - r.last >= REBUILD_FACT_DELTA) return true;
    return r.built_at < ageCutoff && r.fc > r.last;
  });

  // Most-stale first: never-built (built_at null) first, then oldest built_at.
  due.sort((a, b) => {
    if (a.built_at === null && b.built_at !== null) return -1;
    if (b.built_at === null && a.built_at !== null) return 1;
    return (a.built_at ?? "").localeCompare(b.built_at ?? "");
  });

  return due.slice(0, max).map((r) => r.id);
}

/** Builds the (hardened) synthesis prompt for one entity's facts. */
export function buildConsolidationPrompt(
  entityName: string,
  facts: Array<{ id: number; text: string; category: string; assertedAt: string | null; createdAt: string }>
): { system: string; user: string } {
  const system = consolidationSystem(entityName);
  const lines = facts
    .map((f) => `- [#${f.id} ${f.category} ${(f.assertedAt ?? f.createdAt).slice(0, 10)}] ${f.text}`)
    .join("\n");
  const user = `Entity: ${entityName}\nFacts:\n${lines}`;
  return { system, user };
}

/**
 * Builds (or rebuilds) one entity's dossier. Returns {built:false} when there's
 * nothing usable or the LLM call fails — leaving any prior profile intact.
 */
export async function consolidateEntity(
  pool: DbPool,
  entityId: number,
  deps: ConsolidateDeps
): Promise<{ built: boolean; version?: number }> {
  const entity = await getEntityById(pool, entityId);
  if (!entity) return { built: false };

  const allFacts = await getMemoriesByIds(pool, await getEntityMemoryIds(pool, entityId));
  const totalActive = allFacts.length;
  // Exclude sensitive facts from synthesis (never fold them into a summary).
  const usable = allFacts.filter((f) => f.sensitivity !== "sensitive");
  if (usable.length === 0) return { built: false };

  const { system, user } = buildConsolidationPrompt(entity.canonicalName, usable);
  const modelId = deps.model === "sonnet" ? OPENAI_CONSOLIDATION_MODEL : OPENAI_EXTRACT_MODEL;

  const result = await extractJson({
    system,
    user,
    schema: PROFILE_SCHEMA as unknown as Record<string, unknown>,
    model: modelId,
    operation: "consolidate",
    promptVersion: activePromptVersionId("consolidation"),
    apiKey: deps.apiKey,
    fetchImpl: deps.fetchImpl,
    now: deps.now,
    maxTokens: 1024,
  });

  if (!result || typeof result !== "object") return { built: false };
  const profileMd = (result as { profile_md?: unknown }).profile_md;
  if (typeof profileMd !== "string" || profileMd.trim().length === 0) return { built: false };

  const rawIds = (result as { key_fact_ids?: unknown }).key_fact_ids;
  const keyFactIds = Array.isArray(rawIds)
    ? rawIds.filter((n): n is number => typeof n === "number")
    : usable.map((f) => f.id);

  const version = await upsertEntityProfile(pool, {
    entityId,
    profileMd: profileMd.slice(0, MAX_PROFILE_CHARS),
    sourceFactIds: keyFactIds,
    factCount: totalActive,
    model: modelId,
    now: deps.now ? new Date(deps.now()) : new Date(),
  });

  return { built: true, version };
}

/** One consolidation tick: (re)builds up to MAX_CONSOLIDATIONS_PER_TICK dossiers. */
export async function runConsolidation(
  pool: DbPool,
  deps: ConsolidateDeps
): Promise<{ built: number }> {
  const nowMs = (deps.now ?? Date.now)();
  const due = await selectEntitiesDueForConsolidation(pool, nowMs, MAX_CONSOLIDATIONS_PER_TICK);
  let built = 0;
  for (const id of due) {
    try {
      const r = await consolidateEntity(pool, id, deps);
      if (r.built) built++;
    } catch (err) {
      log.warn({ err, entityId: id }, "consolidateEntity failed (non-fatal)");
    }
  }
  if (built > 0) log.info({ built }, "Consolidated entity dossiers");
  return { built };
}
