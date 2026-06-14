import {
  writeFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { viewerScopeToEnv, type ViewerScope } from "../access/scope.js";

const log = createLogger("mcp-config");

export interface McpConfigOptions {
  /** Asker scope, threaded into the memory MCP server so canView runs there too. */
  viewer?: ViewerScope;
}

/**
 * Resolves the tmpdir that holds per-spawn MCP config files. Each file contains
 * every MCP server's plaintext credentials (Metabase password, GitHub token,
 * Notion bearer header, Slack user token, Google client secret + refresh
 * token), so each is written with owner-only (0600) perms, removed by the spawn
 * that created it, and swept on shutdown.
 *
 * Namespaced by SENTINEL_MCP_TMPDIR (set in tests) so test runs can't clobber a
 * production tmpdir.
 */
function resolveConfigDir(): string {
  return process.env.SENTINEL_MCP_TMPDIR ?? join(tmpdir(), "sentinel-mcp");
}

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export function getMcpConfigPath(opts: McpConfigOptions = {}): string {
  // Unique path per call: with MAX_CONCURRENT spawns sharing one tmpdir, a
  // write racing the Claude CLI's read of a fixed-path file could yield torn
  // JSON. A fresh randomUUID-named file per spawn removes that race; the
  // caller removes its own file once the CLI has finished reading it.
  const dir = resolveConfigDir();
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `mcp-config-${randomUUID()}.json`);

  const mcpConfig: McpConfig = {
    mcpServers: {},
  };

  // Metabase — requires URL + EITHER an API key OR username+password.
  const hasMetabase =
    config.METABASE_URL &&
    (config.METABASE_API_KEY ||
      (config.METABASE_USERNAME && config.METABASE_PASSWORD));

  if (hasMetabase) {
    // Only emit the keys that are actually set, so an unset var is never
    // written into the spawned env as the string "undefined".
    const metabaseEnv: Record<string, string> = {
      METABASE_URL: config.METABASE_URL!,
    };
    if (config.METABASE_API_KEY) {
      metabaseEnv.METABASE_API_KEY = config.METABASE_API_KEY;
    }
    if (config.METABASE_USERNAME) {
      metabaseEnv.METABASE_USERNAME = config.METABASE_USERNAME;
    }
    if (config.METABASE_PASSWORD) {
      metabaseEnv.METABASE_PASSWORD = config.METABASE_PASSWORD;
    }

    mcpConfig.mcpServers.metabase = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "metabase.js")],
      env: metabaseEnv,
    };
    log.info("Metabase MCP server registered");
  } else {
    log.warn("Metabase credentials not set — Metabase disabled");
  }

  // GitHub — requires token
  if (config.GITHUB_TOKEN) {
    mcpConfig.mcpServers.github = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: {
        GITHUB_PERSONAL_ACCESS_TOKEN: config.GITHUB_TOKEN,
      },
    };
    log.info("GitHub MCP server registered");
  } else {
    log.warn("GITHUB_TOKEN not set — GitHub disabled");
  }

  // Notion — requires API key
  if (config.NOTION_API_KEY) {
    mcpConfig.mcpServers.notion = {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${config.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        }),
      },
    };
    log.info("Notion MCP server registered");
  } else {
    log.warn("NOTION_API_KEY not set — Notion disabled");
  }

  // Slack search — requires user token
  if (config.SLACK_USER_TOKEN) {
    mcpConfig.mcpServers["slack-search"] = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "slack.js")],
      env: {
        SLACK_USER_TOKEN: config.SLACK_USER_TOKEN,
      },
    };
    log.info("Slack search MCP server registered");
  } else {
    log.warn("SLACK_USER_TOKEN not set — Slack search disabled");
  }

  // Google Workspace (Gmail, Calendar, Transcripts) — requires OAuth credentials
  const hasGoogle =
    config.GOOGLE_CLIENT_ID &&
    config.GOOGLE_CLIENT_SECRET &&
    config.GOOGLE_REFRESH_TOKEN;

  if (hasGoogle) {
    const googleEnv = {
      GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID!,
      GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET!,
      GOOGLE_REFRESH_TOKEN: config.GOOGLE_REFRESH_TOKEN!,
    };

    mcpConfig.mcpServers.gmail = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "gmail.js")],
      env: googleEnv,
    };

    mcpConfig.mcpServers["google-calendar"] = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "calendar.js")],
      env: googleEnv,
    };

    mcpConfig.mcpServers["meeting-transcripts"] = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "transcripts.js")],
      env: googleEnv,
    };

    mcpConfig.mcpServers["google-meet"] = {
      command: "node",
      args: [join(process.cwd(), "dist", "mcp", "meet.js")],
      env: googleEnv,
    };

    log.info("Google Workspace MCP servers registered (Gmail, Calendar, Transcripts, Meet)");
  } else {
    log.warn("Google credentials not set — Gmail, Calendar, and Transcripts disabled");
  }

  // Memory — registered UNCONDITIONALLY: SQLITE_DB_PATH always has a config
  // default and the server needs no credentials. The path is resolved to an
  // ABSOLUTE path because the Claude CLI child process (which spawns the
  // server) may run with a different cwd than the Sentinel process.
  const memoryEnv: Record<string, string> = {
    SQLITE_DB_PATH: resolve(config.SQLITE_DB_PATH),
  };
  // Pass the ACL mode + sensitivity gate so the MCP server matches in-process
  // policy, and the per-request viewer scope so canView runs at the MCP edge.
  if (process.env.MEMORY_ACL_MODE) memoryEnv.MEMORY_ACL_MODE = process.env.MEMORY_ACL_MODE;
  if (process.env.MEMORY_SENSITIVE_RECALL) {
    memoryEnv.MEMORY_SENSITIVE_RECALL = process.env.MEMORY_SENSITIVE_RECALL;
  }
  if (opts.viewer) Object.assign(memoryEnv, viewerScopeToEnv(opts.viewer));

  mcpConfig.mcpServers.memory = {
    command: "node",
    args: [join(process.cwd(), "dist", "mcp", "memory.js")],
    env: memoryEnv,
  };
  log.info("Memory MCP server registered");

  // This file holds plaintext credentials for every MCP server, so write it
  // owner-only. writeFileSync's `mode` applies on create (each path is fresh);
  // chmod explicitly too, in case a name ever collides with an existing file.
  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  log.info({ path: configPath, servers: Object.keys(mcpConfig.mcpServers) }, "Wrote MCP config");

  return configPath;
}

/**
 * Removes a single per-spawn MCP config file (which contains plaintext
 * credentials). Safe to call when the file is already gone — does not throw.
 * Each Claude spawn calls this for its own path once the CLI has finished
 * reading it, so secrets don't linger in the tmpdir between requests.
 */
export function removeMcpConfig(path: string): void {
  if (existsSync(path)) {
    rmSync(path, { force: true });
    log.info({ path }, "Removed MCP config");
  }
}

/**
 * Sweeps ALL mcp-config*.json files from the tmpdir. Wired into graceful
 * shutdown so any orphaned per-spawn files (including the one generated at
 * startup) are removed and secrets don't linger. Safe to call when the dir is
 * absent or empty — does not throw.
 */
export function cleanupMcpConfig(): void {
  const dir = resolveConfigDir();
  if (!existsSync(dir)) {
    return;
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("mcp-config") && entry.endsWith(".json")) {
      const path = join(dir, entry);
      rmSync(path, { force: true });
      log.info({ path }, "Removed MCP config");
    }
  }
}

/**
 * Returns the list of data sources that are NOT available due to missing config.
 */
export function getUnavailableSources(): string[] {
  const unavailable: string[] = [];

  const hasMetabase =
    config.METABASE_URL &&
    (config.METABASE_API_KEY ||
      (config.METABASE_USERNAME && config.METABASE_PASSWORD));

  if (!hasMetabase) {
    unavailable.push("Metabase");
  }

  if (!config.GITHUB_TOKEN) {
    unavailable.push("GitHub");
  }

  if (!config.NOTION_API_KEY) {
    unavailable.push("Notion");
  }

  if (!config.SLACK_USER_TOKEN) {
    unavailable.push("Slack search");
  }

  const hasGoogle =
    config.GOOGLE_CLIENT_ID &&
    config.GOOGLE_CLIENT_SECRET &&
    config.GOOGLE_REFRESH_TOKEN;

  if (!hasGoogle) {
    unavailable.push("Gmail");
    unavailable.push("Google Calendar");
    unavailable.push("Meeting Transcripts");
    unavailable.push("Google Meet");
  }

  return unavailable;
}
