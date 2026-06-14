import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function freshDb(): Promise<{ db: Database.Database; closeDb: () => void }> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  const { getDb, closeDb } = await import("../src/state/db.js");
  return { db: getDb(), closeDb };
}

const now = new Date("2026-06-14T00:00:00.000Z");

describe("getTeamRoster", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("returns the lead (manages) and members (member_of) above the display threshold", async () => {
    const { createEntity, upsertEdge, getTeamRoster } = await import("../src/memory/entitySql.js");
    const team = createEntity(db, { type: "team", canonicalName: "Placements" });
    const lead = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const m1 = createEntity(db, { type: "person", canonicalName: "Priya Nair" });
    const weak = createEntity(db, { type: "person", canonicalName: "Maybe Member" });

    upsertEdge(db, { srcId: lead.id, dstId: team.id, relation: "manages", confidence: 0.7, now });
    upsertEdge(db, { srcId: m1.id, dstId: team.id, relation: "member_of", confidence: 0.7, now });
    upsertEdge(db, { srcId: weak.id, dstId: team.id, relation: "member_of", confidence: 0.4, now });

    const roster = getTeamRoster(db, team.id, now);
    expect(roster.lead?.entityId).toBe(lead.id);
    expect(roster.members.map((m) => m.entityId)).toEqual([m1.id]); // weak edge hidden
    closeDb();
  });
});

describe("getRelatedEntities", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("follows an 'owns' edge above threshold and hides sub-threshold edges", async () => {
    const { createEntity, upsertEdge, getRelatedEntities } = await import("../src/memory/entitySql.js");
    const person = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const project = createEntity(db, { type: "project", canonicalName: "Pricing Revamp" });
    const faint = createEntity(db, { type: "metric", canonicalName: "NPS" });

    upsertEdge(db, { srcId: person.id, dstId: project.id, relation: "owns", confidence: 0.7, now });
    upsertEdge(db, { srcId: person.id, dstId: faint.id, relation: "owns", confidence: 0.3, now });

    const owned = getRelatedEntities(db, person.id, "owns", now);
    expect(owned.map((o) => o.entityId)).toEqual([project.id]);
    expect(owned[0].name).toBe("Pricing Revamp");
    closeDb();
  });

  it("displays a freshly-derived base-confidence (0.5) edge after a sub-second decay tick", async () => {
    // Regression: with the threshold == the base confidence, any real-time
    // decay (querying milliseconds after the edge was written) pushed a fresh
    // edge just below the cutoff, so org_lookup/team_roster returned nothing.
    const { createEntity, upsertEdge, getRelatedEntities } = await import("../src/memory/entitySql.js");
    const person = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const team = createEntity(db, { type: "team", canonicalName: "Placements" });
    const writtenAt = new Date("2026-06-14T00:00:00.000Z");
    upsertEdge(db, { srcId: person.id, dstId: team.id, relation: "manages", confidence: 0.5, now: writtenAt });
    // Queried 500ms later — a tiny but non-zero decay.
    const later = new Date(writtenAt.getTime() + 500);
    expect(getRelatedEntities(db, person.id, "manages", later)).toHaveLength(1);
    closeDb();
  });

  it("decays a stale edge below the threshold so it drops out", async () => {
    const { createEntity, upsertEdge, getRelatedEntities } = await import("../src/memory/entitySql.js");
    const person = createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    const project = createEntity(db, { type: "project", canonicalName: "Old Project" });
    // Edge updated ~150 days before `now` at 0.7 → decays well below 0.5.
    upsertEdge(db, {
      srcId: person.id,
      dstId: project.id,
      relation: "owns",
      confidence: 0.7,
      now: new Date("2026-01-15T00:00:00.000Z"),
    });
    expect(getRelatedEntities(db, person.id, "owns", now)).toHaveLength(0);
    closeDb();
  });
});
