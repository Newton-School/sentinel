/**
 * Postgres test harness. SQLite gave each test file a private `:memory:` DB;
 * Postgres has no in-memory mode, so we give each vitest WORKER its own real
 * database (`sentinel_test_<workerId>`) for full cross-worker isolation, and
 * TRUNCATE between tests for cross-test isolation within a worker.
 *
 * Requires a local/CI Postgres reachable at TEST_PG_BASE_URL (default
 * postgres://localhost:5432). The role must be able to CREATE DATABASE.
 */
import pg from "pg";

const BASE = (process.env.TEST_PG_BASE_URL ?? "postgres://localhost:5432").replace(/\/$/, "");
const WORKER = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "1";

/** This worker's dedicated test database name. */
export const TEST_DB = `sentinel_test_${WORKER}`;
/** Full connection URL for this worker's test database. */
export const TEST_DATABASE_URL = `${BASE}/${TEST_DB}`;

const ENSURED = Symbol.for("sentinel.test.dbEnsured");

/** Creates this worker's test database if it doesn't already exist (once per worker). */
export async function ensureTestDatabase(): Promise<void> {
  const g = globalThis as Record<symbol, unknown>;
  if (g[ENSURED]) return;
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres` });
  try {
    const r = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEST_DB]);
    if (r.rowCount === 0) {
      // TEST_DB is a controlled identifier (worker id), not user input.
      await admin.query(`CREATE DATABASE ${TEST_DB}`);
    }
  } catch (err) {
    // A racing worker may create it first — ignore "already exists" (42P04).
    if ((err as { code?: string }).code !== "42P04") throw err;
  } finally {
    await admin.end();
  }
  g[ENSURED] = true;
}

/**
 * Truncates every app table for a clean slate between tests. Reflects the live
 * schema (information_schema) so it stays correct as tables are added.
 */
export async function resetTestDb(): Promise<void> {
  const { getPool } = await import("../../src/state/db.js");
  const pool = getPool();
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
  );
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(", ");
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}
