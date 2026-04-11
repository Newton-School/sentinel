import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("mcp-config");

interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

let configPath: string | null = null;

export function getMcpConfigPath(): string {
  if (configPath) return configPath;

  const dir = join(tmpdir(), "sentinel-mcp");
  mkdirSync(dir, { recursive: true });
  configPath = join(dir, "mcp-config.json");

  const mcpConfig: McpConfig = {
    mcpServers: {
      metabase: {
        command: "node",
        args: [join(process.cwd(), "dist", "mcp", "metabase.js")],
        env: {
          METABASE_URL: config.METABASE_URL,
          METABASE_USERNAME: config.METABASE_USERNAME,
          METABASE_PASSWORD: config.METABASE_PASSWORD,
        },
      },
      github: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: config.GITHUB_TOKEN,
        },
      },
      notion: {
        command: "npx",
        args: ["-y", "@notionhq/notion-mcp-server"],
        env: {
          OPENAPI_MCP_HEADERS: JSON.stringify({
            Authorization: `Bearer ${config.NOTION_API_KEY}`,
            "Notion-Version": "2022-06-28",
          }),
        },
      },
    },
  };

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

    log.info("Google Workspace MCP servers registered (Gmail, Calendar, Transcripts)");
  } else {
    log.warn("Google credentials not set — Gmail, Calendar, and Transcripts disabled");
  }

  writeFileSync(configPath, JSON.stringify(mcpConfig, null, 2));
  log.info({ path: configPath, servers: Object.keys(mcpConfig.mcpServers) }, "Wrote MCP config");

  return configPath;
}

/**
 * Returns the list of data sources that are NOT available due to missing config.
 */
export function getUnavailableSources(): string[] {
  const unavailable: string[] = [];

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
  }

  return unavailable;
}
