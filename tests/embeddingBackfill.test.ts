import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbPool, Queryable } from "../src/state/db.js";

vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const NOW = () => Date.parse("2026-06-14T00:00:00.000Z");

/** The `memories.embedding` column is a fixed-width `vector(1536)`; pgvector
 * rejects any other dimension. Pad a few meaningful leading values out to 1536
 * (zeros) so cosine ordering still keys off the leading components. */
const EMBED_DIMS = 1536;
function vec1536(...leading: number[]): Float32Array {
  const v = new Float32Array(EMBED_DIMS);
  for (let i = 0; i < leading.length && i < EMBED_DIMS; i++) v[i] = leading[i];
  return v;
}

async function freshDb(): Promise<{ pool: DbPool; closeDb: () => Promise<void> }> {
  vi.resetModules();
  vi.doMock("../src/config.js", () => ({
    config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
  }));
  const { initDb, getPool, closeDb } = await import("../src/state/db.js");
  await initDb();
  const { resetTestDb } = await import("./helpers/pgTest.js");
  await resetTestDb();
  return { pool: getPool(), closeDb };
}

async function insertMemory(q: Queryable, text: string, sensitivity = "normal"): Promise<number> {
  const now = "2026-06-10T00:00:00.000Z";
  return (
    (
      await q.query(
        `INSERT INTO memories (text, category, source_type, sensitivity, content_hash, created_at, updated_at)
         VALUES ($1, 'fact', 'meeting', $2, $3, $4, $5) RETURNING id`,
        [text, sensitivity, `h-${text}`, now, now]
      )
    ).rows[0] as { id: number }
  ).id;
}

/** Fake OpenAI returning a deterministic 1536-dim vector per input. */
function fakeOpenAI() {
  const fn = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const inputs: string[] = body.input;
    return new Response(
      JSON.stringify({
        data: inputs.map((s, index) => ({
          index,
          embedding: Array.from(vec1536(s.length, 1)),
        })),
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return fn;
}

describe("memorySql embedding storage", () => {
  let pool: DbPool;
  let closeDb: () => Promise<void>;
  beforeEach(async () => {
    ({ pool, closeDb } = await freshDb());
  });

  it("setEmbedding writes the vector and is idempotent (only when NULL)", async () => {
    const { setEmbedding } = await import("../src/memory/memorySql.js");
    const { parseVector } = await import("../src/memory/embedder.js");
    const id = await insertMemory(pool, "a fact");

    await setEmbedding(pool, id, vec1536(1, 2, 3));
    const read1 = (await pool.query("SELECT embedding FROM memories WHERE id=$1", [id]))
      .rows[0] as { embedding: string };
    expect(Array.from(parseVector(read1.embedding)!.slice(0, 3))).toEqual([1, 2, 3]);

    // Second write is a no-op (AND embedding IS NULL guard).
    await setEmbedding(pool, id, vec1536(9, 9, 9));
    const read2 = (await pool.query("SELECT embedding FROM memories WHERE id=$1", [id]))
      .rows[0] as { embedding: string };
    expect(Array.from(parseVector(read2.embedding)!.slice(0, 3))).toEqual([1, 2, 3]);
    await closeDb();
  });

  it("memoriesMissingEmbedding excludes sensitive, embedded, and non-active rows", async () => {
    const { memoriesMissingEmbedding, setEmbedding } = await import("../src/memory/memorySql.js");
    const plain = await insertMemory(pool, "plain fact");
    const sensitive = await insertMemory(pool, "comp is 90 LPA", "sensitive");
    const embedded = await insertMemory(pool, "already embedded");
    await setEmbedding(pool, embedded, vec1536(1));
    const forgotten = await insertMemory(pool, "forgotten fact");
    await pool.query("UPDATE memories SET status='forgotten' WHERE id=$1", [forgotten]);

    const missing = await memoriesMissingEmbedding(pool, 50);
    const ids = missing.map((m) => m.id);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(sensitive);
    expect(ids).not.toContain(embedded);
    expect(ids).not.toContain(forgotten);
    await closeDb();
  });
});

describe("backfillEmbeddings", () => {
  let pool: DbPool;
  let closeDb: () => Promise<void>;
  beforeEach(async () => {
    ({ pool, closeDb } = await freshDb());
  });

  it("embeds missing non-sensitive rows in a batch and is idempotent on re-run", async () => {
    const { backfillEmbeddings } = await import("../src/memory/embeddingBackfill.js");
    await insertMemory(pool, "first fact");
    await insertMemory(pool, "second fact");
    await insertMemory(pool, "secret", "sensitive");

    const res = await backfillEmbeddings(pool, { apiKey: "k", fetchImpl: fakeOpenAI(), now: NOW });
    expect(res.scanned).toBe(2); // sensitive excluded
    expect(res.embedded).toBe(2);

    const embeddedCount = Number(
      ((await pool.query("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL")).rows[0] as { n: string }).n
    );
    expect(embeddedCount).toBe(2);

    // Re-run: nothing left to embed.
    const again = await backfillEmbeddings(pool, { apiKey: "k", fetchImpl: fakeOpenAI(), now: NOW });
    expect(again.scanned).toBe(0);
    await closeDb();
  });

  it("returns zero and embeds nothing without an API key", async () => {
    const { backfillEmbeddings } = await import("../src/memory/embeddingBackfill.js");
    await insertMemory(pool, "a fact");
    const res = await backfillEmbeddings(pool, { now: NOW });
    expect(res.embedded).toBe(0);
    await closeDb();
  });
});

describe("isEmbeddingsEnabled", () => {
  beforeEach(() => { delete process.env.MEMORY_EMBEDDINGS; });

  it("is true only when MEMORY_EMBEDDINGS=1 AND a key is configured", async () => {
    vi.resetModules();
    vi.doMock("../src/config.js", () => ({
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent", MEMORY_EMBEDDING_API_KEY: "k" },
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
      config: { DATABASE_URL: process.env.DATABASE_URL, PG_POOL_MAX: 5, LOG_LEVEL: "silent" },
    }));
    const { isEmbeddingsEnabled } = await import("../src/memory/embeddingBackfill.js");
    process.env.MEMORY_EMBEDDINGS = "1";
    expect(isEmbeddingsEnabled()).toBe(false);
    delete process.env.MEMORY_EMBEDDINGS;
  });
});
