# Sentinel — Leadership Data Bot

> **This README documents the original 3-source POC and is partly stale.**
> For the current architecture see [`ARCHITECTURE.md`](ARCHITECTURE.md); for the
> prioritized backlog (including known P0 bugs) see [`TODO.md`](TODO.md).

## Context

miniOG serves developers via Slack with code workflows. Founders and leaders need a similar AI assistant but focused on **business data, org health, and strategic insights**. The bot maintains an evolving persona per user so responses adapt to what each leader cares about.

The project began as a Metabase + GitHub + Notion POC and has since grown to integrate
**Slack search, Gmail, Google Calendar, Google Meet (API v2), and Meeting Transcripts**,
plus a **Playwright Google Meet auto-join + transcription bot** driven by a calendar watcher.

**Key decisions:**
- **Name**: Sentinel
- **AI**: Claude Code CLI (subprocess spawn, same pattern as miniOG)
- **Data sources**: Metabase, GitHub, Notion, Slack-search, Gmail, Google Calendar, Google Meet, Meeting Transcripts (all optional — gated on config)
- **Deployment**: Docker → AWS CodeBuild → ECR → Kubernetes

---

## Directory Structure

```
sentinel/
├── .env.example
├── Dockerfile / docker-compose.yml / buildspec.yml   # Docker + AWS CodeBuild CI
├── package.json / tsconfig.json
├── CLAUDE.md / ARCHITECTURE.md / TODO.md
├── scripts/
│   ├── google-auth.js              # Mint GOOGLE_REFRESH_TOKEN (OAuth helper)
│   └── test-oauth.js               # Validate Google OAuth scopes
├── src/
│   ├── index.ts                    # Entry: bootstrap DB, MCP config, health server, Meet watcher, Slack app
│   ├── config.ts                   # .env loader with Zod validation
│   ├── slack/                      # socketClient.ts, threadContext.ts, formatters.ts (mrkdwn)
│   ├── claude/                     # runner.ts (spawn CLI), systemPrompt.ts, mcpConfig.ts
│   ├── mcp/                        # Custom MCP servers (stdio): metabase, slack, gmail,
│   │                               #   calendar, meet, transcripts. GitHub/Notion are npx packages.
│   ├── meet-bot/                   # Playwright Meet bot: watcher, joiner, eventFilter,
│   │                               #   modeDispatch, meetUrl, setup
│   ├── persona/                    # store.ts, tracker.ts, types.ts (SQLite-backed persona)
│   ├── state/db.ts                 # SQLite setup, WAL mode, migrations (personas/traits/query_log)
│   ├── health/server.ts            # /health + /ready HTTP endpoints
│   ├── logging/logger.ts           # Pino structured logger
│   └── types/contracts.ts          # Shared types (SlackEventEnvelope, etc.)
└── tests/                          # vitest suite (45 files, 526 tests)
```

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy and fill in env vars
cp .env.example .env

# Run in dev mode
npm run dev

# Build
npm run build

# Run production
npm start
```

## Google Meet Bot

A separate pipeline auto-records meetings. After a one-time `npm run meet-bot:setup`
(interactive Google sign-in that persists a Chrome profile under `data/`), the
calendar watcher — started automatically by `npm start` when Google creds are set —
polls every 60s and spawns a detached Playwright joiner for upcoming meetings. The
joiner enables Google's server-side transcription; transcripts are read back later via
the Meet / Transcripts MCP servers. See [`docs/MEET_TRANSCRIPT_EXPERIMENT.md`](docs/MEET_TRANSCRIPT_EXPERIMENT.md).

> The deployed container can run the Meet bot: the `Dockerfile` runtime stage uses the
> Playwright base image with Google Chrome installed (#25) and runs as the non-root
> `pwuser` (#41).

## Organizational memory (company brain)

Sentinel keeps a persistent SQLite-backed store of durable organizational facts
(decisions, owners, deadlines, metrics) and recalls the most relevant ones into every
answer. It learns automatically from three sources — Slack conversations with the bot,
transcripts of meetings the Meet bot attended, and recent internal email — and supports
explicit "remember/forget/correct that" requests via chat (`memory_*` MCP tools).

- **Env:** `ANTHROPIC_API_KEY` is required for fact extraction (without it, memory is
  recall-only). `MEMORY_GMAIL_DOMAINS` extends the internal-sender email allowlist;
  `MEMORY_INGEST_MEET=0` / `MEMORY_INGEST_GMAIL=0` are per-source kill switches read on
  every ingest tick.
- **Cost:** extraction runs on claude-haiku-4-5 with a 500-call/day budget —
  roughly $0.30–0.50/day at normal volume.
- **Security posture:** internal-sender-only email ingestion, verbatim evidence-quote
  validation on every extracted fact, and recalled memories are injected as records —
  explicitly *not* instructions — into the prompt.
- **Observability:** `sentinel_memory_*` counters on the `/metrics` endpoint (facts
  stored by source, extraction errors, budget exhaustion, injected/empty retrievals).

## Deployment

```bash
# Local / single-host
docker-compose up -d
docker-compose logs -f sentinel
```

CI/CD is AWS CodeBuild (`buildspec.yml`): type-check → test → `docker build` → push to
ECR → deploy to Kubernetes.

---

## Further Docs

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — current-state architecture (source of truth)
- [`TODO.md`](TODO.md) — prioritized backlog
- [`PLAN.md`](PLAN.md) — original implementation plan (**stale**; predates the Meet bot and the Gmail/Calendar/Meet/Transcripts MCP servers)
- [`SENTINEL_PRD_V1.md`](SENTINEL_PRD_V1.md) — product requirements (**partly stale**; lists Jira as a v1 source that isn't implemented)
