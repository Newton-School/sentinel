import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Pool } from "pg";
import { allocateInjection, renderDossier } from "../src/agent/injectionBudget.js";
import { buildSystemPrompt } from "../src/agent/systemPrompt.js";
import type { EntityDossierRef, RetrievalBundle } from "../src/memory/types.js";
import type { PersonaProfile } from "../src/persona/types.js";

const persona: PersonaProfile = {
  userId: "U1", displayName: "Dipesh", role: null,
  createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z",
};

function dossier(over: Partial<EntityDossierRef>): EntityDossierRef {
  return {
    entityId: 1, name: "Placements Team", type: "team",
    profileMd: "Owns Q3 employer pipeline.\nPushed CTC target to 14 LPA.",
    version: 2, builtAt: "2026-06-12T00:00:00.000Z", ...over,
  };
}

function bundle(over: Partial<RetrievalBundle>): RetrievalBundle {
  return { queryFacts: [], entityFacts: [], mentionedEntities: [], dossiers: [], ...over };
}

describe("renderDossier", () => {
  it("collapses the profile to a single labeled line", () => {
    const line = renderDossier(dossier({}));
    expect(line).toBe(
      "- [dossier: Placements Team — updated 2026-06-12] Owns Q3 employer pipeline. Pushed CTC target to 14 LPA."
    );
  });
});

describe("allocateInjection — dossier tier", () => {
  it("renders dossier blocks ahead of facts", () => {
    const plan = allocateInjection(bundle({ dossiers: [dossier({})] }));
    expect(plan.dossierBlocks).toHaveLength(1);
    expect(plan.dossierBlocks[0]).toContain("Placements Team");
  });

  it("drops a whole dossier that exceeds the tier budget (never half)", () => {
    const huge = dossier({ profileMd: "z".repeat(5000) });
    const plan = allocateInjection(bundle({ dossiers: [huge] }), {
      dossiers: 200, entityFacts: 0, queryFacts: 0, total: 200,
    });
    expect(plan.dossierBlocks).toHaveLength(0);
    expect(plan.usedChars).toBe(0);
  });
});

describe("buildSystemPrompt — dossier rendering", () => {
  it("renders a dossier block under the People & teams subsection", () => {
    const out = buildSystemPrompt(persona, [], [], undefined, bundle({ dossiers: [dossier({})] }));
    expect(out).toContain("People & teams in this question");
    expect(out).toContain("dossier: Placements Team");
    expect(out).toContain("Owns Q3 employer pipeline");
  });
});

// --- assembleRetrieval: a dossier replaces an entity's raw facts -------------

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent", ALLOWED_USER_IDS: ["U1"] },
  }));
  const { initDb, getPool } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  const store = await import("../src/memory/memoryStore.js");
  const entitySql = await import("../src/memory/entitySql.js");
  const scope = await import("../src/access/scope.js");
  return { db: getPool(), store, entitySql, scope };
}

async function insertMemory(db: Pool, text: string): Promise<number> {
  const now = "2026-06-14T00:00:00.000Z";
  return (
    (await db.query(
      `INSERT INTO memories (text, category, source_type, content_hash, created_at, updated_at)
       VALUES ($1, 'fact', 'manual', $2, $3, $4) RETURNING id`,
      [text, `h-${text}`, now, now]
    )).rows[0] as { id: number }
  ).id;
}

describe("assembleRetrieval — dossier replaces raw facts", () => {
  beforeEach(() => { delete process.env.MEMORY_ACL_MODE; });
  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("returns a dossier for a mentioned entity and suppresses its raw facts", async () => {
    const { db, store, entitySql, scope } = await load();
    const team = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const factId = await insertMemory(db, "obscure linked detail");
    await entitySql.linkMemoryEntity(db, { memoryId: factId, entityId: team.id, role: "subject" });
    await entitySql.upsertEntityProfile(db, {
      entityId: team.id, profileMd: "Owns the Q3 pipeline.", sourceFactIds: [factId],
      factCount: 1, model: "haiku", now: new Date("2026-06-12T00:00:00.000Z"),
    });

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const b = await store.assembleRetrieval("what is the placements team doing", "U1", viewer);
    expect(b.dossiers.map((d) => d.entityId)).toContain(team.id);
    // raw fact suppressed because the dossier covers the entity
    expect(b.entityFacts.map((f) => f.id)).not.toContain(factId);
  });

  it("falls back to raw entity facts when the entity has no dossier", async () => {
    const { db, store, entitySql, scope } = await load();
    const team = await entitySql.createEntity(db, { type: "team", canonicalName: "Placements Team" });
    const factId = await insertMemory(db, "linked detail");
    await entitySql.linkMemoryEntity(db, { memoryId: factId, entityId: team.id, role: "subject" });

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const b = await store.assembleRetrieval("placements team", "U1", viewer);
    expect(b.dossiers).toHaveLength(0);
    expect(b.entityFacts.map((f) => f.id)).toContain(factId);
  });
});
