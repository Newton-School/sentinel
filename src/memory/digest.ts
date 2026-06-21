/**
 * Digest builders: "what changed about an entity / across the org recently".
 *
 * Pure-ish (db handle + injected `sinceMs`, no clock) so it's testable and
 * reusable both by the on-demand MCP tools (entity_digest / org_digest) and by
 * a future scheduled proactive push (which would call the same builders with a
 * recipient's ViewerScope).
 *
 * Scope-safe: facts are filtered through `canView` for the viewer (when given)
 * and sensitive facts are excluded — a digest is a broad summary, not a
 * targeted retrieval, so it never surfaces HR/comp/legal/medical content.
 */

import type { Queryable } from "../state/db.js";
import { canView, type ViewerScope } from "../access/scope.js";
import { getMemoriesByIds, recentFactsSince } from "./memorySql.js";
import { getEntityById, getEntityMemoryIds } from "./entitySql.js";
import type { MemoryRow } from "./types.js";

export interface DigestFact {
  id: number;
  text: string;
  category: string;
  sourceType: string;
  assertedAt: string | null;
  createdAt: string;
}

export interface EntityDigest {
  entityId: number;
  name: string;
  type: string;
  sinceIso: string;
  newFacts: DigestFact[];
}

export interface OrgDigest {
  sinceIso: string;
  items: Array<DigestFact & { subject?: string }>;
}

function visibleInDigest(m: MemoryRow, viewer?: ViewerScope): boolean {
  if (m.sensitivity === "sensitive") return false; // never in broad summaries
  if (!viewer) return true;
  return canView(
    {
      visibility: m.visibility,
      subjectEntityId: m.subjectEntityId,
      scopeTeamId: m.scopeTeamId,
      sensitivity: m.sensitivity,
    },
    viewer
  );
}

function shape(m: MemoryRow): DigestFact {
  return {
    id: m.id,
    text: m.text,
    category: m.category,
    sourceType: m.sourceType,
    assertedAt: m.assertedAt,
    createdAt: m.createdAt,
  };
}

const byCreatedDesc = (a: MemoryRow, b: MemoryRow): number =>
  a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.id - a.id;

/** What changed about one entity since `sinceMs` (newest first, scope-filtered). */
export async function entityDigest(
  q: Queryable,
  entityId: number,
  sinceMs: number,
  viewer?: ViewerScope,
  limit = 20
): Promise<EntityDigest | null> {
  const e = await getEntityById(q, entityId);
  if (!e) return null;
  const sinceIso = new Date(sinceMs).toISOString();
  const newFacts = (await getMemoriesByIds(q, await getEntityMemoryIds(q, entityId)))
    .filter((m) => m.createdAt >= sinceIso && visibleInDigest(m, viewer))
    .sort(byCreatedDesc)
    .slice(0, limit)
    .map(shape);
  return { entityId: e.id, name: e.canonicalName, type: e.type, sinceIso, newFacts };
}

/** What changed across the org since `sinceMs` (newest first, scope-filtered). */
export async function orgDigest(
  q: Queryable,
  sinceMs: number,
  viewer?: ViewerScope,
  limit = 30
): Promise<OrgDigest> {
  const sinceIso = new Date(sinceMs).toISOString();
  // Over-fetch so scope/sensitivity filtering still leaves up to `limit`.
  const rows = (await recentFactsSince(q, sinceIso, limit * 3)).filter((m) =>
    visibleInDigest(m, viewer)
  );
  const items = await Promise.all(
    rows.slice(0, limit).map(async (m) => {
      const subject =
        m.subjectEntityId != null
          ? (await getEntityById(q, m.subjectEntityId))?.canonicalName
          : undefined;
      return { ...shape(m), subject };
    })
  );
  return { sinceIso, items };
}
