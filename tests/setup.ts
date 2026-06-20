// Global vitest setup — runs once per worker BEFORE any test file is imported
// (registered via setupFiles in vitest.config.ts).
//
// Tests must never touch real/shared runtime state. The DB-touching tests mock
// `src/config.js` with SQLITE_DB_PATH: ":memory:" (or a throwaway path), so they
// never write the repo-root ./sentinel.db. tests/config.test.ts exercises the
// real loadConfig() against process.env and asserts the SQLITE_DB_PATH default,
// so we deliberately do NOT force SQLITE_DB_PATH globally here.
//
// (The former MCP per-spawn config tmpdir isolation was removed with the Claude
// CLI harness — there is no longer a temp-file credential sink to redirect.)
export {};
