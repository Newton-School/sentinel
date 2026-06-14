/**
 * Access-control seam for the company brain. A single pure predicate,
 * `canView`, decides whether a viewer may see a memory; it is applied at BOTH
 * recall edges (the in-process `searchMemories` and the memory MCP server).
 *
 * Two modes, switched by `MEMORY_ACL_MODE`:
 *  - 'founders' (default, the only ACTIVE policy): a founder sees everything,
 *    nobody else sees anything — provably equivalent to the pre-brain
 *    behaviour, where every row is visibility='founders' and only founders
 *    query the bot. This is the entire blast-radius control: the data model and
 *    scoped logic ship now but stay inert until the mode flips.
 *  - 'scoped' (built now, activated in Phase E): tier + per-team checks for a
 *    future team-member audience.
 *
 * Pure and DB-free (testable like rank.ts); the only impurity is `aclMode()`
 * reading the env, mirroring the other runtime kill switches.
 */

export type Visibility = "public" | "team" | "leadership" | "founders";
export type Role = "founder" | "leadership" | "manager" | "member" | "unknown";
export type AclMode = "founders" | "scoped";

export interface ViewerScope {
  userId: string;
  role: Role;
  /** The asker's own entity, if resolved (used for personal-scope checks). */
  entityId: number | null;
  /** Teams the asker belongs to or manages. */
  teamIds: number[];
  /** Visibility tiers this role may read. */
  allowedTiers: Set<Visibility>;
}

/** The ACL-relevant fields of a memory (subset of MemoryRow). */
export interface MemoryAclFields {
  visibility: string;
  subjectEntityId?: number | null;
  scopeTeamId?: number | null;
  sensitivity?: string;
}

/** Current ACL mode from the env (default 'founders'). */
export function aclMode(): AclMode {
  return process.env.MEMORY_ACL_MODE === "scoped" ? "scoped" : "founders";
}

/** Visibility tiers a role may read (scoped mode). */
export function allowedTiersForRole(role: Role): Set<Visibility> {
  switch (role) {
    case "founder":
      return new Set<Visibility>(["public", "team", "leadership", "founders"]);
    case "leadership":
      return new Set<Visibility>(["public", "team", "leadership"]);
    case "manager":
    case "member":
      return new Set<Visibility>(["public", "team"]);
    default:
      return new Set<Visibility>(["public"]);
  }
}

export interface ViewerScopeContext {
  /** User ids treated as founders (see everything). */
  founderUserIds: string[];
  /** Optional explicit per-user role overrides. */
  roleMap?: Record<string, Role>;
  /** The asker's resolved entity id, if known. */
  entityId?: number | null;
  /** Teams the asker belongs to / manages, if known. */
  teamIds?: number[];
}

/** Resolves an asker into a ViewerScope. Pure: the caller supplies the context. */
export function buildViewerScope(userId: string, ctx: ViewerScopeContext): ViewerScope {
  const role: Role =
    ctx.roleMap?.[userId] ?? (ctx.founderUserIds.includes(userId) ? "founder" : "unknown");
  return {
    userId,
    role,
    entityId: ctx.entityId ?? null,
    teamIds: ctx.teamIds ?? [],
    allowedTiers: allowedTiersForRole(role),
  };
}

/**
 * Whether `viewer` may see `memory`. In founders mode this reduces to
 * "is the viewer a founder"; scoped mode adds tier + per-team checks.
 */
export function canView(
  memory: MemoryAclFields,
  viewer: ViewerScope,
  mode: AclMode = aclMode()
): boolean {
  if (mode === "founders") {
    return viewer.role === "founder";
  }

  const vis = (memory.visibility as Visibility) ?? "founders";
  if (!viewer.allowedTiers.has(vis)) return false;

  // Team-tier rows narrow to the scoped team's members (founders/leadership
  // see across teams).
  if (vis === "team" && viewer.role !== "founder" && viewer.role !== "leadership") {
    const teamScope = memory.scopeTeamId ?? null;
    return teamScope !== null && viewer.teamIds.includes(teamScope);
  }
  return true;
}
