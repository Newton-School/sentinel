/**
 * The dashboard's own Postgres connection pool — deliberately separate from the
 * bot's in-process getPool() singleton (src/state/db.ts). The dashboard runs as
 * its own process and connects through a dedicated SELECT-only role, so it can
 * never write and never runs migrations. In local dev it falls back to the
 * normal DATABASE_URL when no read-only URL is configured.
 */

import pg from "pg";
import { dashboardEnv, type DashboardEnv } from "./env.js";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/**
 * The DB URL the dashboard reads from: the dedicated SELECT-only role in prod
 * (DATABASE_URL_READONLY), falling back to DATABASE_URL for local dev. Throws
 * when neither is set.
 */
export function resolveReadOnlyDbUrl(
  env: Pick<DashboardEnv, "DATABASE_URL_READONLY" | "DATABASE_URL"> = dashboardEnv
): string {
  const url = env.DATABASE_URL_READONLY ?? env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "dashboard requires DATABASE_URL_READONLY (or DATABASE_URL) to be set"
    );
  }
  return url;
}

/** Lazily create and memoize the read-only pool. */
export function getReadOnlyPool(): pg.Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: resolveReadOnlyDbUrl(), max: dashboardEnv.PG_POOL_MAX });
  return _pool;
}

export async function closeReadOnlyPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
