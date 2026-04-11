# Sentinel

Leadership data bot POC — Slack bot powered by Claude CLI with MCP tools for Metabase, GitHub, and Notion.

## Build & Run

- `npm run dev` — run in dev mode with tsx
- `npm run build` — compile TypeScript
- `npm start` — run compiled JS
- `npm test` — run tests with vitest

## Architecture

- **Slack Socket Mode** via @slack/bolt — handles mentions, DMs, slash commands
- **Claude CLI** spawned as subprocess with `--mcp-config` for tool access
- **MCP servers**: Metabase (custom), GitHub (@modelcontextprotocol/server-github), Notion (@modelcontextprotocol/server-notion)
- **Persona system**: SQLite-backed per-user persona that evolves based on query patterns
- **Module system**: ESM with NodeNext resolution — all imports use `.js` extensions

## Development Workflow (TDD)

Every feature request MUST follow this strict Test-Driven Development workflow:

1. **Understand** — Read the requirement thoroughly. Ask clarifying questions if anything is ambiguous. Do not start coding until the requirement is clear.
2. **Write tests first** — Before writing any implementation code, write failing tests that define the expected behavior. Tests go in `tests/` and use vitest.
3. **Run tests (confirm red)** — Run `npm test` to verify the new tests fail as expected. This confirms the tests are actually testing something.
4. **Implement** — Write the minimum code needed to make all tests pass. Do not add untested behavior.
5. **Run tests (confirm green)** — Run `npm test` to verify all tests pass (both new and existing).
6. **Run build** — Run `npm run build` to verify TypeScript compilation succeeds.
7. **Create PR and merge** — If all tests pass and build succeeds, create a PR and merge it.
8. **Fix and retest** — If any test fails, fix the implementation (not the tests, unless the test itself is wrong), then rerun from step 5.

Never skip writing tests. Never submit code with failing tests.

## Conventions

- TypeScript strict mode, ESM modules
- All relative imports must include `.js` extension
- Pino for structured logging
- Zod for config/input validation
- SQLite with WAL mode for persistence
