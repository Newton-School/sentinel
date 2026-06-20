# Sentinel

Leadership data bot for Newton School — a Slack bot powered by an in-process
OpenAI Agents SDK agent loop over MCP tools, plus a Playwright Google Meet
auto-join + transcription pipeline.

> **Full current-state map: see [`ARCHITECTURE.md`](ARCHITECTURE.md). Prioritized
> backlog (incl. known P0 bugs): see [`TODO.md`](TODO.md).** The older `README.md`,
> `PLAN.md`, and `SENTINEL_PRD_V1.md` describe the earlier 3-source POC and are stale.

## Build & Run

- `npm run dev` — run in dev mode with tsx
- `npm run build` — compile TypeScript (required before `npm start`: MCP servers run from `dist/mcp/*.js`)
- `npm start` — run compiled JS
- `npm test` — run tests with vitest
- `npm run meet-bot:setup` — one-time interactive Google sign-in for the Meet bot profile
- `npm run meet-bot:join` — manually run the per-meeting Playwright joiner

## Architecture

- **Slack Socket Mode** via @slack/bolt — handles mentions, DMs, slash commands
- **OpenAI Agents SDK** (`@openai/agents`, in `src/agent/`) — runs the agentic
  reply loop in-process on a GPT-5-class model (`OPENAI_REPLY_MODEL`), connecting
  the MCP servers per request as the MCP client
- **MCP servers** (up to 8, all gated on config presence): Metabase, Slack-search,
  Gmail, Google Calendar, Meeting-transcripts, and Google Meet (all custom, in
  `src/mcp/`), plus GitHub (`@modelcontextprotocol/server-github`) and Notion
  (`@notionhq/notion-mcp-server`) via npx. There is **no** `src/mcp/github.ts` or
  `src/mcp/notion.ts`.
- **Meet bot** (`src/meet-bot/`): a calendar watcher polls every 60s and spawns a
  detached Playwright Chrome joiner that joins meetings and enables Google's
  server-side transcription; transcripts are later read back via the Meet/Transcripts
  MCP servers.
- **Persona system**: SQLite-backed per-user persona that evolves based on query patterns
- **Health/deploy**: `/health` (liveness) + `/ready` (readiness) + `/metrics` (Prometheus) HTTP endpoints; Docker → AWS CodeBuild → ECR → K8s
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
