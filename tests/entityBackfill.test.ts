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

function insertMemory(
  db: Database.Database,
  text: string,
  entities: string[],
  category = "fact"
): number {
  const now = "2026-06-14T00:00:00.000Z";
  const row = db
    .prepare(
      `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'meeting', ?, ?, ?) RETURNING id`
    )
    .get(text, category, JSON.stringify(entities), `h-${text}`, now, now) as { id: number };
  return row.id;
}

describe("backfillEntityLinks", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("links active memories that have entity names but no links yet", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    const { getMemoryEntities } = await import("../src/memory/entitySql.js");

    const m1 = insertMemory(db, "Anjali Mehta owns onboarding", ["Anjali Mehta"], "owner");
    const m2 = insertMemory(db, "general note, no entities", []);

    const res = backfillEntityLinks(db, { now: new Date("2026-06-14T00:00:00.000Z") });
    expect(res.scanned).toBe(1); // m2 has empty entities, not scanned
    expect(res.linked).toBe(1);
    expect(getMemoryEntities(db, m1).length).toBeGreaterThan(0);
    expect(getMemoryEntities(db, m2)).toHaveLength(0);
    closeDb();
  });

  it("is idempotent — a second run links nothing new", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    insertMemory(db, "Anjali Mehta owns onboarding", ["Anjali Mehta"], "owner");

    const first = backfillEntityLinks(db);
    expect(first.linked).toBe(1);
    const second = backfillEntityLinks(db);
    expect(second.scanned).toBe(0); // already-linked memories are skipped
    expect(second.linked).toBe(0);
    closeDb();
  });

  it("respects the batch limit", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    insertMemory(db, "Anjali Mehta owns A", ["Anjali Mehta"], "owner");
    insertMemory(db, "Bhuvan Rao owns B", ["Bhuvan Rao"], "owner");
    insertMemory(db, "Chitra Das owns C", ["Chitra Das"], "owner");

    const res = backfillEntityLinks(db, { limit: 2 });
    expect(res.scanned).toBe(2);
    closeDb();
  });

  it("skips non-active memories", async () => {
    const { backfillEntityLinks } = await import("../src/memory/entityLink.js");
    const id = insertMemory(db, "Dev Kumar owns D", ["Dev Kumar"], "owner");
    db.prepare(`UPDATE memories SET status='forgotten' WHERE id = ?`).run(id);
    const res = backfillEntityLinks(db);
    expect(res.scanned).toBe(0);
    closeDb();
  });
});

describe("entity resolution metrics", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("counts matched / created / ambiguous resolution outcomes", async () => {
    const { linkFactEntities } = await import("../src/memory/entityLink.js");
    const { createEntity } = await import("../src/memory/entitySql.js");
    const { snapshot, reset, renderPrometheus } = await import("../src/metrics/registry.js");
    reset();

    // matched: existing exact entity
    createEntity(db, { type: "person", canonicalName: "Rahul Sharma" });
    // ambiguous: two "Rahul *"
    createEntity(db, { type: "person", canonicalName: "Rahul Verma" });

    const mk = (text: string, entities: string[]) =>
      db
        .prepare(
          `INSERT INTO memories (text, category, entities, source_type, content_hash, created_at, updated_at)
           VALUES (?, 'fact', ?, 'manual', ?, '2026-06-14T00:00:00.000Z', '2026-06-14T00:00:00.000Z') RETURNING id`
        )
        .get(text, JSON.stringify(entities), `h-${text}`) as { id: number };

    linkFactEntities(db, mk("about Rahul Sharma", ["Rahul Sharma"]).id, {
      text: "about Rahul Sharma", category: "fact", entities: ["Rahul Sharma"], sourceType: "manual",
    });
    linkFactEntities(db, mk("new person", ["Anjali Mehta"]).id, {
      text: "new person", category: "fact", entities: ["Anjali Mehta"], sourceType: "manual",
    });
    linkFactEntities(db, mk("ambiguous", ["Rahul"]).id, {
      text: "ambiguous", category: "fact", entities: ["Rahul"], sourceType: "manual",
    });

    const snap = snapshot();
    expect(snap.memory.entitiesResolved.matched).toBe(1);
    expect(snap.memory.entitiesResolved.created).toBe(1);
    expect(snap.memory.entitiesResolved.ambiguous).toBe(1);

    expect(renderPrometheus()).toContain('sentinel_memory_entity_resolved_total{outcome="matched"}');
    closeDb();
  });
});
