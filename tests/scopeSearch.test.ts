import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

async function load() {
  const store = await import("../src/memory/memoryStore.js");
  const scope = await import("../src/access/scope.js");
  return { store, scope };
}

describe("searchMemories — viewer scope threading", () => {
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

  it("a founder ViewerScope sees stored facts (founders mode)", async () => {
    const { store, scope } = await load();
    await store.insertFact({
      text: "Q3 placement target is 300 offers",
      category: "decision",
      sourceType: "manual",
    });
    const viewer = scope.buildViewerScope("U1", { founderUserIds: ["U1"] });
    const results = await store.searchMemories("placement target", 6, viewer);
    expect(results.length).toBeGreaterThan(0);
  });

  it("a non-founder ViewerScope sees nothing (founders mode)", async () => {
    const { store, scope } = await load();
    await store.insertFact({
      text: "Q3 placement target is 300 offers",
      category: "decision",
      sourceType: "manual",
    });
    const stranger = scope.buildViewerScope("U9", { founderUserIds: ["U1"] });
    const results = await store.searchMemories("placement target", 6, stranger);
    expect(results).toHaveLength(0);
  });

  it("the legacy string viewer still filters by visibility (backward compatible)", async () => {
    const { store } = await load();
    await store.insertFact({
      text: "Q3 placement target is 300 offers",
      category: "decision",
      sourceType: "manual",
    });
    // Default + explicit string viewer behave as before.
    expect((await store.searchMemories("placement target")).length).toBeGreaterThan(0);
    expect((await store.searchMemories("placement target", 6, "founders")).length).toBeGreaterThan(0);
    expect(await store.searchMemories("placement target", 6, "nobody")).toHaveLength(0);
  });
});
