import { describe, it, expect } from "vitest";
import {
  resolveEntity,
  FUZZY_THRESHOLD,
  type EntityCandidate,
} from "../src/memory/entityResolve.js";

function person(over: Partial<EntityCandidate>): EntityCandidate {
  return {
    id: 1,
    type: "person",
    canonicalName: "X",
    normalizedName: "x",
    aliases: [],
    slackUserId: null,
    email: null,
    ...over,
  };
}

describe("resolveEntity ladder", () => {
  it("matches by slack_user_id at confidence 1.0, beating a name collision", () => {
    const candidates = [
      person({ id: 7, canonicalName: "Rahul Sharma", normalizedName: "rahul sharma", slackUserId: "U7" }),
      person({ id: 8, canonicalName: "Rahul Verma", normalizedName: "rahul verma" }),
    ];
    const d = resolveEntity({ rawName: "Rahul", slackUserId: "U7" }, candidates);
    expect(d.match).toBe("slack_id");
    expect(d.entityId).toBe(7);
    expect(d.confidence).toBe(1.0);
    expect(d.shouldCreate).toBe(false);
  });

  it("matches by email when no slack id matches", () => {
    const candidates = [person({ id: 3, email: "rahul@newtonschool.co" })];
    const d = resolveEntity(
      { rawName: "Rahul", email: "rahul@newtonschool.co" },
      candidates
    );
    expect(d.match).toBe("email");
    expect(d.entityId).toBe(3);
    expect(d.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("matches an exact normalized name", () => {
    const candidates = [
      person({ id: 5, canonicalName: "Placements Team", normalizedName: "placements team", type: "team" }),
    ];
    const d = resolveEntity({ rawName: "placements team", type: "team" }, candidates);
    expect(d.match).toBe("exact_name");
    expect(d.entityId).toBe(5);
  });

  it("matches an existing alias", () => {
    const candidates = [
      person({ id: 9, canonicalName: "Rahul Sharma", normalizedName: "rahul sharma", aliases: ["rahul s"] }),
    ];
    const d = resolveEntity({ rawName: "Rahul S." }, candidates);
    expect(d.match).toBe("alias");
    expect(d.entityId).toBe(9);
  });

  it("resolves 'Rahul S' to canonical 'Rahul Sharma' via fuzzy and records a new alias", () => {
    const candidates = [
      person({ id: 11, canonicalName: "Rahul Sharma", normalizedName: "rahul sharma" }),
    ];
    const d = resolveEntity({ rawName: "Rahul S" }, candidates);
    expect(d.match).toBe("fuzzy");
    expect(d.entityId).toBe(11);
    expect(d.confidence).toBeGreaterThanOrEqual(0.6);
    expect(d.confidence).toBeLessThan(0.85);
    expect(d.newAlias).toBe("rahul s");
  });

  it("returns shouldCreate=false for an ambiguous bare 'Rahul' with two fuzzy candidates", () => {
    const candidates = [
      person({ id: 1, canonicalName: "Rahul Sharma", normalizedName: "rahul sharma" }),
      person({ id: 2, canonicalName: "Rahul Verma", normalizedName: "rahul verma" }),
    ];
    const d = resolveEntity({ rawName: "Rahul" }, candidates);
    expect(d.match).toBe("none");
    expect(d.entityId).toBeUndefined();
    expect(d.shouldCreate).toBe(false);
  });

  it("creates a new person for an unseen 2-token name", () => {
    const d = resolveEntity({ rawName: "Anjali Mehta" }, []);
    expect(d.match).toBe("none");
    expect(d.shouldCreate).toBe(true);
    expect(d.confidence).toBeLessThan(0.8); // name-only creations are low-confidence
  });

  it("does NOT create from a single bare token with no candidates", () => {
    const d = resolveEntity({ rawName: "Rahul" }, []);
    expect(d.match).toBe("none");
    expect(d.shouldCreate).toBe(false);
  });

  it("creates at high confidence when a hard key is present but unmatched", () => {
    const d = resolveEntity({ rawName: "Rahul", slackUserId: "U99" }, []);
    expect(d.match).toBe("none");
    expect(d.shouldCreate).toBe(true);
    expect(d.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("does not create from empty/punctuation-only names without a hard key", () => {
    const d = resolveEntity({ rawName: "  ... " }, []);
    expect(d.shouldCreate).toBe(false);
  });

  it("FUZZY_THRESHOLD is a sane similarity cutoff", () => {
    expect(FUZZY_THRESHOLD).toBeGreaterThan(0.4);
    expect(FUZZY_THRESHOLD).toBeLessThan(0.9);
  });
});
