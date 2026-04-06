# Sentinel — Leadership Data Bot POC

## Context

miniOG serves developers via Slack with code workflows. Founders and leaders need a similar AI assistant but focused on **business data, org health, and strategic insights** — pulling from Metabase (SQL analytics), GitHub (engineering activity), and Notion (docs/projects). The bot maintains an evolving persona per user so responses adapt to what each leader cares about.

**Key decisions:**
- **Name**: Sentinel
- **AI**: Claude Code CLI (subprocess spawn, same pattern as miniOG)
- **Data sources**: Metabase + GitHub + Notion (all three in POC)
- **Deployment**: Docker on EC2

---

## Directory Structure

```
sentinel/
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── CLAUDE.md
├── src/
│   ├── index.ts                    # Entry: bootstrap, start Slack client, wire handlers
│   ├── config.ts                   # .env loader with Zod validation
│   ├── slack/
│   │   ├── socketClient.ts         # @slack/bolt Socket Mode (adapted from sidecar)
│   │   └── threadContext.ts        # Fetch thread replies for conversation context
│   ├── claude/
│   │   ├── runner.ts               # Spawn `claude` CLI subprocess with prompt + tools
│   │   ├── systemPrompt.ts         # System prompt builder with persona injection
│   │   └── mcpConfig.ts            # Generate MCP server config for Claude CLI
│   ├── mcp/
│   │   ├── metabase.ts             # Metabase MCP server (session auth, SQL queries, dashboards)
│   │   ├── github.ts               # GitHub MCP (uses @modelcontextprotocol/server-github)
│   │   └── notion.ts               # Notion MCP (uses @modelcontextprotocol/server-notion)
│   ├── persona/
│   │   ├── store.ts                # SQLite CRUD for personas + traits
│   │   ├── tracker.ts              # Analyze queries, evolve persona traits
│   │   └── types.ts                # Persona type definitions
│   ├── state/
│   │   └── db.ts                   # SQLite setup, WAL mode, migrations
│   ├── logging/
│   │   └── logger.ts               # Pino structured logger
│   └── types/
│       └── contracts.ts            # Shared types (SlackEventEnvelope, etc.)
└── tests/
    ├── persona.test.ts
    └── config.test.ts
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

## Docker Deployment (EC2)

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f sentinel
```

---

## Implementation Plan

See [PLAN.md](PLAN.md) for the full implementation plan with step-by-step details.
