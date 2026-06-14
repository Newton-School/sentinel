import { describe, it, expect, vi, beforeEach } from "vitest";
import type Database from "better-sqlite3";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const NOW = () => Date.parse("2026-06-14T00:00:00.000Z");

async function freshDb(): Promise<{ db: Database.Database; closeDb: () => void }> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
  }));
  const { getDb, closeDb } = await import("../src/state/db.js");
  return { db: getDb(), closeDb };
}

function insertMemory(db: Database.Database, text: string, sensitivity = "normal"): number {
  const now = "2026-06-10T00:00:00.000Z";
  return (
    db.prepare(
      `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
       VALUES (?, 'fact', 'meeting', ?, ?, ?, ?) RETURNING id`
    ).get(text, sensitivity, `h-${text}`, now, now) as { id: number }
  ).id;
}

/** Fake OpenAI returning a deterministic 2-dim vector per input. */
function fakeOpenAI() {
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const inputs: string[] = body.input;
    return new Response(
      JSON.stringify({
        data: inputs.map((s, index) => ({ index, embedding: [s.length, 1] })),
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return fn;
}

describe("memorySql embedding storage", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("setEmbedding writes the blob and is idempotent (only when NULL)", async () => {
    const { setEmbedding } = await import("../src/memory/memorySql.js");
    const { floatToBlob, blobToFloat } = await import("../src/memory/embedder.js");
    const id = insertMemory(db, "a fact");

    setEmbedding(db, id, floatToBlob(new Float32Array([1, 2, 3])));
    const read1 = db.prepare("SELECT embedding FROM memories WHERE id=?").get(id) as { embedding: Buffer };
    expect(Array.from(blobToFloat(read1.embedding))).toEqual([1, 2, 3]);

    // Second write is a no-op (AND embedding IS NULL guard).
    setEmbedding(db, id, floatToBlob(new Float32Array([9, 9, 9])));
    const read2 = db.prepare("SELECT embedding FROM memories WHERE id=?").get(id) as { embedding: Buffer };
    expect(Array.from(blobToFloat(read2.embedding))).toEqual([1, 2, 3]);
    closeDb();
  });

  it("memoriesMissingEmbedding excludes sensitive, embedded, and non-active rows", async () => {
    const { memoriesMissingEmbedding, setEmbedding } = await import("../src/memory/memorySql.js");
    const { floatToBlob } = await import("../src/memory/embedder.js");
    const plain = insertMemory(db, "plain fact");
    const sensitive = insertMemory(db, "comp is 90 LPA", "sensitive");
    const embedded = insertMemory(db, "already embedded");
    setEmbedding(db, embedded, floatToBlob(new Float32Array([1])));
    const forgotten = insertMemory(db, "forgotten fact");
    db.prepare("UPDATE memories SET status='forgotten' WHERE id=?").run(forgotten);

    const missing = memoriesMissingEmbedding(db, 50);
    const ids = missing.map((m) => m.id);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(sensitive);
    expect(ids).not.toContain(embedded);
    expect(ids).not.toContain(forgotten);
    closeDb();
  });
});

describe("backfillEmbeddings", () => {
  let db: Database.Database;
  let closeDb: () => void;
  beforeEach(async () => {
    ({ db, closeDb } = await freshDb());
  });

  it("embeds missing non-sensitive rows in a batch and is idempotent on re-run", async () => {
    const { backfillEmbeddings } = await import("../src/memory/embeddingBackfill.js");
    insertMemory(db, "first fact");
    insertMemory(db, "second fact");
    insertMemory(db, "secret", "sensitive");

    const res = await backfillEmbeddings(db, { apiKey: "k", fetchImpl: fakeOpenAI(), now: NOW });
    expect(res.scanned).toBe(2); // sensitive excluded
    expect(res.embedded).toBe(2);

    const embeddedCount = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL").get() as { n: number }).n;
    expect(embeddedCount).toBe(2);

    // Re-run: nothing left to embed.
    const again = await backfillEmbeddings(db, { apiKey: "k", fetchImpl: fakeOpenAI(), now: NOW });
    expect(again.scanned).toBe(0);
    closeDb();
  });

  it("returns zero and embeds nothing without an API key", async () => {
    const { backfillEmbeddings } = await import("../src/memory/embeddingBackfill.js");
    insertMemory(db, "a fact");
    const res = await backfillEmbeddings(db, { now: NOW });
    expect(res.embedded).toBe(0);
    closeDb();
  });
});

describe("isEmbeddingsEnabled", () => {
  beforeEach(() => { delete process.env.MEMORY_EMBEDDINGS; });

  it("is true only when MEMORY_EMBEDDINGS=1 AND a key is configured", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent", MEMORY_EMBEDDING_API_KEY: "k" },
    }));
    const { isEmbeddingsEnabled } = await import("../src/memory/embeddingBackfill.js");
    expect(isEmbeddingsEnabled()).toBe(false); // flag unset
    process.env.MEMORY_EMBEDDINGS = "1";
    expect(isEmbeddingsEnabled()).toBe(true);
    delete process.env.MEMORY_EMBEDDINGS;
  });

  it("is false when the flag is set but no key is configured", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { SQLITE_DB_PATH: ":memory:", LOG_LEVEL: "silent" },
    }));
    const { isEmbeddingsEnabled } = await import("../src/memory/embeddingBackfill.js");
    process.env.MEMORY_EMBEDDINGS = "1";
    expect(isEmbeddingsEnabled()).toBe(false);
    delete process.env.MEMORY_EMBEDDINGS;
  });
});
