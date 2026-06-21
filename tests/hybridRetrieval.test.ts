import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

/**
 * The `memories.embedding` column is pgvector `vector(1536)`, so vectors must be
 * exactly 1536-dim. We place the meaningful 2-component signal at the front and
 * zero-pad the rest; cosine direction (what `<=>` ranks on) is preserved, so an
 * orthogonal pair `[1,0,…]` / `[0,1,…]` behaves exactly like the old 2-dim test.
 */
const DIM = 1536;
function vec(...head: number[]): Float32Array {
  const v = new Float32Array(DIM);
  head.forEach((x, i) => { v[i] = x; });
  return v;
}

async function load() {
  const { getPool } = await import("../src/state/db.js");
  const store = await import("../src/memory/memoryStore.js");
  const sql = await import("../src/memory/memorySql.js");
  const scope = await import("../src/access/scope.js");
  return { pool: getPool(), store, sql, scope };
}

describe("assembleRetrieval — hybrid (semantic) recall", () => {
  beforeEach(async () => {
    delete process.env.MEMORY_ACL_MODE;
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: {
        DATABASE_URL: process.env.DATABASE_URL,
        PG_POOL_MAX: 5,
        LOG_LEVEL: "silent",
        ALLOWED_USER_IDS: ["U1"],
      },
    }));
    const { initDb } = await import("../src/state/db.js");
    await initDb();
    const { resetTestDb } = await import("./helpers/pgTest.js");
    await resetTestDb();
  });

  afterEach(async () => {
    const { closeDb } = await import("../src/state/db.js");
    await closeDb();
  });

  it("surfaces a semantically-close fact that does NOT keyword-match the query", async () => {
    const { pool, store, sql, scope } = await load();

    // Two facts, neither sharing query keywords. Give them orthogonal vectors.
    const near = (await store.insertFact({ text: "Compensation bands were revised upward", category: "decision", sourceType: "manual" })).id;
    const far = (await store.insertFact({ text: "The cafeteria menu changed on Tuesday", category: "fact", sourceType: "manual" })).id;
    await sql.setEmbedding(pool, near, vec(1, 0));
    await sql.setEmbedding(pool, far, vec(0, 1));

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    // Query keywords ("salary policy") don't match either fact's text, but the
    // query vector points at the compensation fact.
    const bundle = await store.assembleRetrieval("salary policy", "U1", viewer, vec(1, 0));

    const ids = bundle.queryFacts.map((f) => f.id);
    expect(ids).toContain(near);
    // the compensation fact ranks ahead of the cafeteria one
    expect(ids.indexOf(near)).toBeLessThan(ids.indexOf(far) === -1 ? Infinity : ids.indexOf(far));
  });

  it("without a query vector, semantic facts are not pulled in (BM25-only)", async () => {
    const { pool, store, sql, scope } = await load();
    const id = (await store.insertFact({ text: "Compensation bands revised", category: "decision", sourceType: "manual" })).id;
    await sql.setEmbedding(pool, id, vec(1, 0));

    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const bundle = await store.assembleRetrieval("salary policy", "U1", viewer); // no vector
    expect(bundle.queryFacts.map((f) => f.id)).not.toContain(id);
  });
});
