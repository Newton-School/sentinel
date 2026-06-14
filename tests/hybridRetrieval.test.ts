import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

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
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent", ALLOWED_USER_IDS: ["U1"] },
  }));
  const { getDb } = await import("../src/state/db.js");
  const store = await import("../src/memory/memoryStore.js");
  const sql = await import("../src/memory/memorySql.js");
  const embedder = await import("../src/memory/embedder.js");
  const scope = await import("../src/access/scope.js");
  return { db: getDb(), store, sql, embedder, scope };
}

describe("assembleRetrieval — hybrid (semantic) recall", () => {
  beforeEach(() => { delete process.env.MEMORY_ACL_MODE; });

  it("surfaces a semantically-close fact that does NOT keyword-match the query", async () => {
    const { db, store, sql, embedder, scope } = await load();

    // Two facts, neither sharing query keywords. Give them orthogonal vectors.
    const near = store.insertFact({ text: "Compensation bands were revised upward", category: "decision", sourceType: "manual" }).id;
    const far = store.insertFact({ text: "The cafeteria menu changed on Tuesday", category: "fact", sourceType: "manual" }).id;
    sql.setEmbedding(db, near, embedder.floatToBlob(new Float32Array([1, 0])));
    sql.setEmbedding(db, far, embedder.floatToBlob(new Float32Array([0, 1])));

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    // Query keywords ("salary policy") don't match either fact's text, but the
    // query vector points at the compensation fact.
    const bundle = store.assembleRetrieval("salary policy", "U1", viewer, new Float32Array([1, 0]));

    const ids = bundle.queryFacts.map((f) => f.id);
    expect(ids).toContain(near);
    // the compensation fact ranks ahead of the cafeteria one
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far) === -1 ? Infinity : ids.indexOf(far));
    closeDbSafe(db);
  });

  it("without a query vector, semantic facts are not pulled in (BM25-only)", async () => {
    const { db, store, sql, embedder, scope } = await load();
    const id = store.insertFact({ text: "Compensation bands revised", category: "decision", sourceType: "manual" }).id;
    sql.setEmbedding(db, id, embedder.floatToBlob(new Float32Array([1, 0])));

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const bundle = store.assembleRetrieval("salary policy", "U1", viewer); // no vector
    expect(bundle.queryFacts.map((f) => f.id)).not.toContain(id);
    closeDbSafe(db);
  });
});

function closeDbSafe(db: Database.Database) {
  try { db.close(); } catch { /* ignore */ }
}
