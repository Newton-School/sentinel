import { describe, it, expect, afterEach } from "vitest";
import {
  buildViewerScope,
  canView,
  allowedTiersForRole,
  aclMode,
  type ViewerScope,
} from "../src/access/scope.js";

function scope(over: Partial<ViewerScope>): ViewerScope {
  return {
    userId: "U1",
    role: "founder",
    entityId: null,
    teamIds: [],
    allowedTiers: allowedTiersForRole(over.role ?? "founder"),
    ...over,
  };
}

describe("buildViewerScope", () => {
  it("marks a configured founder as role=founder", () => {
    const v = buildViewerScope("U1", { founderUserIds: ["U1", "U2"] });
    expect(v.role).toBe("founder");
    expect(v.allowedTiers.has("founders")).toBe(true);
  });

  it("marks an unknown user as role=unknown with only public access", () => {
    const v = buildViewerScope("U9", { founderUserIds: ["U1"] });
    expect(v.role).toBe("unknown");
    expect([...v.allowedTiers]).toEqual(["public"]);
  });

  it("honors an explicit role map override", () => {
    const v = buildViewerScope("U5", { founderUserIds: ["U1"], roleMap: { U5: "leadership" } });
    expect(v.role).toBe("leadership");
  });
});

describe("canView — founders mode (the only active policy)", () => {
  it("a founder sees every row (any visibility)", () => {
    const v = scope({ role: "founder" });
    expect(canView({ visibility: "founders" }, v, "founders")).toBe(true);
    expect(canView({ visibility: "team" }, v, "founders")).toBe(true);
    expect(canView({ visibility: "public" }, v, "founders")).toBe(true);
  });

  it("a non-founder sees nothing", () => {
    expect(canView({ visibility: "public" }, scope({ role: "member" }), "founders")).toBe(false);
    expect(canView({ visibility: "founders" }, scope({ role: "unknown" }), "founders")).toBe(false);
  });

  it("is equivalent to the legacy founders-only filter for a founders-tier row", () => {
    // Pre-brain behaviour: keep rows where visibility==='founders' for a founder asker.
    expect(canView({ visibility: "founders" }, scope({ role: "founder" }), "founders")).toBe(true);
  });
});

describe("canView — scoped mode (built now, activated later)", () => {
  it("a founder sees all tiers", () => {
    const v = scope({ role: "founder" });
    for (const vis of ["public", "team", "leadership", "founders"]) {
      expect(canView({ visibility: vis }, v, "scoped")).toBe(true);
    }
  });

  it("leadership sees up to leadership but not founders-tier", () => {
    const v = scope({ role: "leadership" });
    expect(canView({ visibility: "leadership" }, v, "scoped")).toBe(true);
    expect(canView({ visibility: "founders" }, v, "scoped")).toBe(false);
  });

  it("a team-tier row is visible to a member only when on the scoped team", () => {
    const onTeam = scope({ role: "member", teamIds: [42] });
    const offTeam = scope({ role: "member", teamIds: [7] });
    expect(canView({ visibility: "team", scopeTeamId: 42 }, onTeam, "scoped")).toBe(true);
    expect(canView({ visibility: "team", scopeTeamId: 42 }, offTeam, "scoped")).toBe(false);
  });

  it("a member cannot see a leadership-tier row", () => {
    expect(canView({ visibility: "leadership" }, scope({ role: "member" }), "scoped")).toBe(false);
  });
});

describe("aclMode", () => {
  afterEach(() => {
    delete process.env.MEMORY_ACL_MODE;
  });
  it("defaults to founders", () => {
    delete process.env.MEMORY_ACL_MODE;
    expect(aclMode()).toBe("founders");
  });
  it("reads scoped from env", () => {
    process.env.MEMORY_ACL_MODE = "scoped";
    expect(aclMode()).toBe("scoped");
  });
});
