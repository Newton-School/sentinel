import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Global vitest setup — runs once per worker BEFORE any test file is imported
// (registered via setupFiles in vitest.config.ts).
//
// Tests must never touch real/shared runtime state. Two known sinks:
//   1. The MCP per-spawn config tmpdir (src/claude/mcpConfig.ts), which defaults
//      to `<os.tmpdir()>/sentinel-mcp` and holds plaintext credentials. A prior
//      incident (commit 460bb4f, "Fix stale mcp-config.json from test pollution")
//      came from tests writing here. Redirect SENTINEL_MCP_TMPDIR to a unique
//      throwaway dir so the suite can never clobber a real/shared tmpdir.
//   2. The SQLite DB (src/state/db.ts via config.SQLITE_DB_PATH), which defaults
//      to `./sentinel.db` in the repo root.
//
// We set these only if a test process hasn't already provided its own value, so
// any test that manages its own path/handle keeps full control.

if (!process.env.SENTINEL_MCP_TMPDIR) {
  process.env.SENTINEL_MCP_TMPDIR = mkdtempSync(
    join(tmpdir(), "sentinel-mcp-test-"),
  );
}

// NOTE: SQLITE_DB_PATH is intentionally NOT forced here. The DB-touching tests
// already mock `src/config.js` with SQLITE_DB_PATH: ":memory:", so they never
// write a real file. Meanwhile tests/config.test.ts calls the real loadConfig()
// against process.env and asserts the schema default resolves to "./sentinel.db";
// forcing SQLITE_DB_PATH globally would break that assertion. We therefore only
// provide a safe fallback for any test that opens the real DB WITHOUT mocking
// config — but since config reads the env at import time and config.test.ts
// snapshots/restores process.env, we leave the default untouched and rely on the
// existing per-test mocks. See report/PR for the rationale.
