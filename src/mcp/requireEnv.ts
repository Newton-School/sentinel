/**
 * Startup env validation for the custom MCP servers.
 *
 * Each MCP server reads a handful of required env vars at module load. When a
 * server is misconfigured or run directly those reads used to silently produce
 * `undefined`, surfacing later as confusing failures (e.g. `fetch('undefined/api/session')`
 * or googleapis OAuth with undefined credentials). `assertEnv` turns that into an
 * explicit, named failure at startup.
 */

/**
 * Pure: returns the subset of `names` that are missing from `env`.
 *
 * A var counts as missing if it is undefined OR empty/whitespace-only.
 * Order of the returned names matches the order of `names`. Reads only the
 * passed `env` (defaults to `process.env`).
 */
export function findMissingEnv(
  names: string[],
  env: NodeJS.ProcessEnv = process.env
): string[] {
  return names.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === "";
  });
}

/**
 * Validates required env: if any of `names` are missing, logs a clear message
 * naming them and exits with code 1. Otherwise returns normally.
 *
 * `exit` and `error` are injectable for tests; they default to
 * `process.exit` / `console.error`.
 *
 * @param names  Required env var names.
 * @param env    Environment to read (defaults to `process.env`).
 * @param deps   Optional injected `exit` / `error`, plus a `serverName` prefix
 *               for the error message.
 */
export function assertEnv(
  names: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps?: {
    exit?: (code: number) => never;
    error?: (msg: string) => void;
    serverName?: string;
  }
): void {
  const missing = findMissingEnv(names, env);
  if (missing.length === 0) return;

  const exit = deps?.exit ?? (process.exit as (code: number) => never);
  const error = deps?.error ?? ((msg: string) => console.error(msg));
  const prefix = deps?.serverName ? `${deps.serverName}: ` : "";

  error(`${prefix}missing required env: ${missing.join(", ")}`);
  exit(1);
}
