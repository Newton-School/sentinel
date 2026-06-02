# Sentinel — Leadership Data Bot POC

> **This is the ORIGINAL POC plan and is partly stale.** It captures the initial
> three-source design (Metabase + GitHub + Notion). The shipped system has grown
> well beyond it: up to **8 MCP servers**, a Playwright Google Meet bot driven by a
> calendar watcher, a health server, and an audit log. For the current architecture
> see [`ARCHITECTURE.md`](ARCHITECTURE.md) (source of truth) and the backlog in
> [`TODO.md`](TODO.md). Sections below are annotated where they diverge from reality.

## Context

miniOG serves developers via Slack with code workflows. Founders and leaders need a similar AI assistant but focused on **business data, org health, and strategic insights** — pulling from Metabase (SQL analytics), GitHub (engineering activity), and Notion (docs/projects). The bot maintains an evolving persona per user so responses adapt to what each leader cares about.

**Key decisions:**
- **Name**: Sentinel
- **Location**: Separate repo at `~/code/sentinel/`
- **AI**: Claude Code CLI (subprocess spawn, same pattern as miniOG)
- **Data sources (POC)**: Metabase + GitHub + Notion. **Now shipped:** up to 8 MCP
  servers — custom (in `src/mcp/`): Metabase, Slack-search, Gmail, Google Calendar,
  Meeting-transcripts, Google Meet (API v2); plus GitHub (`@modelcontextprotocol/server-github`)
  and Notion (`@notionhq/notion-mcp-server`) via npx. All are optional and gated on config.
- **Deployment**: ~~Docker on EC2~~ → **Docker → AWS CodeBuild → ECR → Kubernetes** (current).

---

## Directory Structure

> **Updated to reflect the shipped tree.** The original POC plan listed
> `src/mcp/github.ts` and `src/mcp/notion.ts` — these were never written; GitHub and
> Notion run as external npx packages, not custom MCP servers. Six custom MCP servers
> live in `src/mcp/`, plus a whole `src/meet-bot/` pipeline and `src/health/`.

```
sentinel/
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── buildspec.yml                   # AWS CodeBuild CI pipeline
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── CLAUDE.md / ARCHITECTURE.md / TODO.md
├── scripts/
│   ├── google-auth.js              # Mint GOOGLE_REFRESH_TOKEN (OAuth helper, 5 scopes)
│   └── test-oauth.js               # Validate Google OAuth credentials/scopes
├── src/
│   ├── index.ts                    # Entry: bootstrap DB + MCP config + health server + Meet watcher + Slack app
│   ├── config.ts                   # .env loader with Zod validation
│   ├── slack/
│   │   ├── socketClient.ts         # @slack/bolt Socket Mode (adapted from sidecar)
│   │   ├── threadContext.ts        # Fetch thread replies for conversation context
│   │   └── formatters.ts           # Markdown → Slack mrkdwn
│   ├── claude/
│   │   ├── runner.ts               # Spawn `claude` CLI subprocess with prompt + tools
│   │   ├── systemPrompt.ts         # System prompt builder with persona injection
│   │   └── mcpConfig.ts            # Generate MCP server config for Claude CLI (up to 8 servers)
│   ├── mcp/                        # Custom stdio MCP servers (GitHub/Notion are npx, NOT here):
│   │   ├── metabase.ts             # Metabase API client (session auth, SQL queries, dashboards)
│   │   ├── slack.ts                # Slack-search server (xoxp user token)
│   │   ├── gmail.ts                # Gmail read (OAuth2)
│   │   ├── calendar.ts             # Google Calendar read (OAuth2)
│   │   ├── transcripts.ts          # Meeting transcripts via Drive + Docs (OAuth2)
│   │   └── meet.ts                 # Google Meet REST API v2 (OAuth2)
│   ├── meet-bot/                   # Playwright Google Meet auto-join pipeline:
│   │   ├── watcher.ts              # Calendar poll loop (every 60s) → spawns joiners
│   │   ├── joiner.ts               # Per-meeting Playwright Chrome joiner (CLI)
│   │   ├── eventFilter.ts          # Decide which calendar events to join
│   │   ├── modeDispatch.ts         # leave-after-join / stay-until-end / hybrid
│   │   ├── meetUrl.ts              # Meet URL parsing
│   │   └── setup.ts                # One-time interactive Google sign-in
│   ├── persona/
│   │   ├── store.ts                # SQLite CRUD for personas + traits
│   │   ├── tracker.ts              # Analyze queries, evolve persona traits
│   │   └── types.ts                # Persona type definitions
│   ├── state/
│   │   └── db.ts                   # SQLite setup, WAL mode, migrations
│   ├── health/
│   │   └── server.ts               # /health (liveness) + /ready (readiness) HTTP endpoints
│   ├── logging/
│   │   └── logger.ts               # Pino structured logger
│   └── types/
│       └── contracts.ts            # Shared types (SlackEventEnvelope, etc.)
└── tests/                          # vitest suite (45 files, 526 tests)
```

---

## Implementation Plan

### Step 1: Scaffold project
- Create `~/code/sentinel/`, `git init`
- `package.json` with dependencies:
  - `@slack/bolt` (Socket Mode)
  - `better-sqlite3` (persona/config storage)
  - `pino` (logging)
  - `zod` (config validation)
  - `dotenv` (env loading)
- `tsconfig.json`: `module: "NodeNext"`, `moduleResolution: "NodeNext"`, strict mode, `.js` extensions on imports
- `.env.example` with all required env vars
- `.gitignore` (node_modules, dist, .env, *.db)

**Key env vars** (POC set shown; the shipped `.env.example` adds Slack-user, Google
Workspace, and health-port vars — see that file for the authoritative list):
```
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
BOT_USER_ID=
SLACK_USER_TOKEN=              # xoxp user token for cross-channel Slack search MCP
CLAUDE_BIN=claude              # Path to claude CLI binary
ANTHROPIC_API_KEY=             # Passed to claude CLI env
METABASE_URL=
METABASE_USERNAME=
METABASE_PASSWORD=
GITHUB_TOKEN=
NOTION_API_KEY=
GOOGLE_CLIENT_ID=             # OAuth2 for Gmail/Calendar/Transcripts/Meet MCP servers
GOOGLE_CLIENT_SECRET=
GOOGLE_REFRESH_TOKEN=         # Must include the 5 scopes google-auth.js requests
HEALTH_CHECK_PORT=8080
SQLITE_DB_PATH=./sentinel.db
ALLOWED_USER_IDS=              # Comma-separated Slack user IDs
LOG_LEVEL=info
```

### Step 2: Config + Logger
- **`src/config.ts`**: Load `.env` via `dotenv`, validate with Zod schema, export typed config object
  - Reference: `sidecar/src/config.ts` for Zod pattern (adapt from SQLite reads to `process.env`)
- **`src/logging/logger.ts`**: Pino logger with component tagging, same as sidecar

### Step 3: SQLite database
- **`src/state/db.ts`**: `better-sqlite3` with WAL mode, inline migrations
  - Reference: `sidecar/src/state/jobStore.ts` lines 17-24 for the pattern

**Tables:**
```sql
-- User personas
CREATE TABLE personas (
  user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT,                          -- 'founder', 'pm', 'leader'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Persona traits that evolve over time
CREATE TABLE persona_traits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  label TEXT NOT NULL,                -- 'focus_area', 'metric_preference', 'team_scope'
  value TEXT NOT NULL,                -- 'revenue', 'weekly_active_users', 'backend'
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, label, value)
);

-- Query log for persona evolution + audit trail
CREATE TABLE query_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  query_text TEXT NOT NULL,
  category TEXT,                     -- 'revenue', 'engineering', 'product', 'team', 'general'
  created_at TEXT NOT NULL,
  -- Audit columns added via guarded ALTERs in src/state/db.ts:
  response_text TEXT,                -- the answer Sentinel returned
  response_duration_ms INTEGER,      -- end-to-end latency of the Claude run
  sources_used TEXT                  -- JSON list of data sources touched (written, not yet read back)
);
-- A joined_meetings table also exists (Meet-watcher join dedup; survives restarts).
```

> **Note:** the shipped migrations also add the three audit columns above and a
> `joined_meetings` dedup table, plus indexes on `query_log(user_id, created_at)` and a
> 90-day retention prune. See `src/state/db.ts`.

### Step 4: Slack Socket Mode client
- **`src/slack/socketClient.ts`**: Adapted from `sidecar/src/slack/socketClient.ts`
  - Same `App({ token, appToken, socketMode: true })` pattern
  - Handle `app_mention` and `message` (DMs) events
  - Register `/sentinel` slash command
  - Normalize events into `SlackEventEnvelope`
  - Access control: check `ALLOWED_USER_IDS` before processing
- **`src/slack/threadContext.ts`**: Adapted from `sidecar/src/slack/threadContext.ts`
  - Fetch thread replies via `conversations.replies`

### Step 5: Claude Code CLI runner
- **`src/claude/runner.ts`**: Spawn `claude` CLI as subprocess
  - Reference: `sidecar/src/codex/runCodex.ts` and `sidecar/src/backends/claudeCodeBackend.ts`
  - Build args: `['--print', prompt, '--output-format', 'text', '--dangerously-skip-permissions']`
  - Pass env: `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`
  - **MCP config**: Pass `--mcp-config <path>` flag pointing to a generated JSON config that registers Metabase/GitHub/Notion as MCP servers
  - Capture stdout as the response text
  - Timeout handling (60s default for data queries)

- **`src/claude/mcpConfig.ts`**: Generate MCP server configuration JSON
  - This tells the Claude CLI about available MCP servers (Metabase, GitHub, Notion)
  - Written to a temp file and passed via `--mcp-config`

- **`src/claude/systemPrompt.ts`**: Build system prompt dynamically
  - Base persona: "You are Sentinel, a data-insights assistant for founders and leaders"
  - Inject user's persona traits (focus areas, preferences)
  - Style: executive-friendly, lead with insights, bullet points, Slack formatting

### Step 6: MCP data sources
Since we're using Claude CLI with `--mcp-config`, the MCP servers need to be either:
- **Option A**: Existing MCP server packages (npm packages that implement MCP protocol) — preferred if they exist
- **Option B**: Custom lightweight MCP servers we write that wrap the APIs

**For POC, we'll use a hybrid approach:**

> **What actually shipped:** Metabase and all Google/Slack servers are **custom**
> stdio servers in `src/mcp/` (run from `dist/mcp/*.js`). GitHub and Notion are
> **external npx packages** — there is **no** `src/mcp/github.ts` or `src/mcp/notion.ts`.
> Notion uses `@notionhq/notion-mcp-server` (NOT `@modelcontextprotocol/server-notion`),
> wired via an `OPENAPI_MCP_HEADERS` env var carrying a `Bearer` token, not `NOTION_API_KEY`.

- **`src/mcp/metabase.ts`**: Lightweight MCP server (stdio-based) that wraps Metabase REST API
  - Tools: `metabase_query` (run SQL), `metabase_get_question` (saved question), `metabase_list_dashboards`, `metabase_list_databases`
  - Auth: Session-based (POST `/api/session`)

- **GitHub**: external `@modelcontextprotocol/server-github` via `npx -y`
  - Auth: `GITHUB_PERSONAL_ACCESS_TOKEN` (from `GITHUB_TOKEN`)

- **Notion**: external `@notionhq/notion-mcp-server` via `npx -y`
  - Auth: `OPENAPI_MCP_HEADERS` = JSON with `Authorization: Bearer <NOTION_API_KEY>` + `Notion-Version`

**MCP config structure as actually generated** (passed to `claude --mcp-config`; see
`src/claude/mcpConfig.ts` for the full set of up to 8 servers — metabase, github, notion,
slack-search, gmail, google-calendar, meeting-transcripts, google-meet):
```json
{
  "mcpServers": {
    "metabase": {
      "command": "node",
      "args": ["dist/mcp/metabase.js"],
      "env": { "METABASE_URL": "...", "METABASE_USERNAME": "...", "METABASE_PASSWORD": "..." }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "..." }
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"],
      "env": { "OPENAPI_MCP_HEADERS": "{\"Authorization\":\"Bearer ...\",\"Notion-Version\":\"2022-06-28\"}" }
    }
  }
}
```

### Step 7: Persona management
- **`src/persona/types.ts`**: Type definitions for `PersonaProfile`, `PersonaTrait`
- **`src/persona/store.ts`**: SQLite CRUD — `getOrCreatePersona`, `getTraits`, `upsertTrait`
- **`src/persona/tracker.ts`**: After each query:
  1. Categorize the query (keyword-based for POC): revenue, engineering, product, team, general
  2. Upsert trait: `focus_area: <category>` with confidence bump
  3. Formula: `new_confidence = old_confidence + (1 - old_confidence) * 0.15`, capped at 0.95
  4. Log the query to `query_log` table

### Step 8: Wire it together — `src/index.ts`
```
1. Load config from .env
2. Initialize SQLite DB + run migrations
3. Generate MCP config file
4. Start Slack Socket Mode client
5. On event:
   a. Check access (allowed user?)
   b. Add :eyes: reaction
   c. Fetch thread context
   d. Load/create user persona
   e. Build system prompt with persona
   f. Spawn claude CLI with system prompt + MCP config + user message + thread context
   g. Post response to Slack thread
   h. Swap :eyes: for :white_check_mark:
   i. Track query for persona evolution
```

No job queue needed for the Q&A path — queries take 10-30s, simple async handler with concurrency limit (semaphore of 3). *(The Meet bot is a separate concern: a calendar watcher started by `index.ts` polls every 60s and spawns detached joiner subprocesses — see `src/meet-bot/`.)*

### Step 9: Docker + EC2 deployment
- **`Dockerfile`**: Multi-stage build (builder + runtime)
  - Runtime needs: Node.js 20 + `claude` CLI binary installed
  - Note: Claude CLI must be available in the Docker image (install via npm or download binary)
- **`docker-compose.yml`**: Single service, env_file, volume for SQLite persistence
- EC2: `t3.small`, Docker + docker-compose, clone repo, `.env`, `docker-compose up -d`

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:20-alpine
RUN npm install -g @anthropic-ai/claude-code
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
```

---

## Key Reference Files (from Watchtower sidecar)
| What to reuse | File |
|---|---|
| Socket Mode client pattern | `sidecar/src/slack/socketClient.ts` |
| Thread context fetching | `sidecar/src/slack/threadContext.ts` |
| Zod config validation | `sidecar/src/config.ts` |
| SQLite + WAL + migrations | `sidecar/src/state/jobStore.ts` |
| Claude CLI subprocess spawn | `sidecar/src/backends/claudeCodeBackend.ts` |
| CLI output parsing | `sidecar/src/codex/runCodex.ts` |
| System prompt building | `sidecar/src/codex/mentionSystemPrompt.ts` |
| Pino logger setup | `sidecar/src/logging/logger.ts` |
| Type contracts | `sidecar/src/types/contracts.ts` |

---

## POC Scope

**In scope:**
- Slack Socket Mode connection (mentions + DMs + `/sentinel` command)
- Claude CLI integration with MCP tools
- Metabase MCP (SQL queries, saved questions)
- GitHub MCP (PRs, issues, repo activity)
- Notion MCP (search pages, read content)
- Persona tracking per user (evolving traits based on query patterns)
- Persona-injected system prompts
- SQLite persistence
- Docker deployment for EC2
- Access control (allowed user IDs)
- Eyes/checkmark reaction UX

**Deferred to v2 (original plan):**
- Proactive insights (daily digests, anomaly alerts) — *partly superseded:* there is now a
  background **calendar watcher** (`src/meet-bot/watcher.ts`) that polls every 60s and
  auto-launches the Meet bot, so the "no scheduled jobs" framing no longer holds.
- Rich Slack Block Kit messages (charts, tables)
- Persona decay logic
- Slash command subcommands (`/sentinel persona`, `/sentinel status`)
- Rate limiting / cost tracking
- ~~Health check endpoint~~ — **DONE.** `src/health/server.ts` serves `/health` (liveness)
  and `/ready` (readiness, gated on Slack + a SQLite `SELECT 1`); the Docker HEALTHCHECK
  hits `/health`.
- Comprehensive test suite — partially done (45 test files; helpers covered, several
  modules still untested)
- Cross-thread conversation memory

**Shipped beyond the original POC plan:**
- **Five more MCP servers** beyond Metabase/GitHub/Notion: Slack-search, Gmail, Google
  Calendar, Meeting-transcripts, and Google Meet (API v2) — all custom, in `src/mcp/`.
- **Playwright Google Meet bot** (`src/meet-bot/`): the calendar watcher polls every 60s,
  filters eligible events, and spawns a **detached** Playwright Chrome joiner per meeting.
  The joiner joins muted, enables Google's server-side transcription, then leaves or stays
  (see stay-mode note below). Transcripts are read back later via the Meet/Transcripts MCP
  servers. One-time sign-in via `npm run meet-bot:setup`; manual join via `npm run meet-bot:join`.
  > **Stay-mode (production):** the watcher hardcodes `--stay-mode stay-until-end` (the PR #17
  > revert — intentional for production), so the live bot stays for the full call. The
  > memory-saving `leave-after-join` mode is the default *of the joiner CLI* and remains
  > available when running `meet-bot:join` by hand; `hybrid` is also available.
- **Audit log**: `query_log` now records `response_text`, `response_duration_ms`, and
  `sources_used` for every interaction (90-day retention).
- **Health server** as above.

---

## Verification

1. **Local dev**: `npm run dev` — bot connects to Slack, responds to mentions
2. **Metabase**: Ask "What were our revenue numbers last month?" — Claude calls metabase_query tool, returns data
3. **GitHub**: Ask "Show me open PRs on newton-web" — Claude calls github list_prs tool
4. **Notion**: Ask "Find the product roadmap doc" — Claude calls notion search_pages tool
5. **Persona**: Ask revenue questions 3-4 times, then ask a vague "give me an update" — response should skew toward revenue metrics
6. **Docker**: `docker-compose up -d` — bot runs headless, survives restart
