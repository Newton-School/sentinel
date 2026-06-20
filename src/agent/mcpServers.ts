import { join, resolve } from "node:path";
import { MCPServerStdio } from "@openai/agents";
import { config } from "../config.js";
import { createLogger } from "../logging/logger.js";
import { viewerScopeToEnv, type ViewerScope } from "../access/scope.js";

const log = createLogger("agent-mcp");

export interface BuildMcpServersOptions {
  /** Asker scope, baked into the memory server env so canView runs there too. */
  viewer?: ViewerScope;
  /**
   * Optional allowlist of server names to emit (besides memory, which is always
   * included). Mirrors mcpConfig's `servers` — the analytics route passes
   * {"metabase"} to restrict the toolset.
   */
  servers?: ReadonlySet<string>;
}

/** A resolved stdio MCP server launch spec (pure data — no process spawned). */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cacheToolsList: boolean;
}

/** Absolute path to a compiled MCP server (the child may run with a different cwd). */
function distServer(file: string): string {
  return join(process.cwd(), "dist", "mcp", file);
}

/**
 * Pure resolver: which stdio MCP servers to launch for this request, gated on
 * credential presence + the optional allowlist. This is the OpenAI-harness
 * analogue of mcpConfig.getMcpConfigPath, minus the per-spawn JSON file — the
 * Agents SDK receives launch specs directly. Kept pure so the gating, allowlist,
 * and the security-critical per-request viewer-scope env are unit-testable.
 */
export function resolveServerSpecs(opts: BuildMcpServersOptions = {}): McpServerSpec[] {
  const specs: McpServerSpec[] = [];
  const allow = (name: string): boolean => !opts.servers || opts.servers.has(name);
  const push = (name: string, file: string, env: Record<string, string>): void => {
    specs.push({ name, command: "node", args: [distServer(file)], env, cacheToolsList: true });
  };

  // Metabase — requires URL + EITHER an API key OR username+password.
  const hasMetabase =
    config.METABASE_URL &&
    (config.METABASE_API_KEY || (config.METABASE_USERNAME && config.METABASE_PASSWORD));
  if (hasMetabase && allow("metabase")) {
    const env: Record<string, string> = { METABASE_URL: config.METABASE_URL! };
    if (config.METABASE_API_KEY) env.METABASE_API_KEY = config.METABASE_API_KEY;
    if (config.METABASE_USERNAME) env.METABASE_USERNAME = config.METABASE_USERNAME;
    if (config.METABASE_PASSWORD) env.METABASE_PASSWORD = config.METABASE_PASSWORD;
    push("metabase", "metabase.js", env);
  }

  // GitHub / Notion — run from the published npm packages via npx.
  if (config.GITHUB_TOKEN && allow("github")) {
    specs.push({
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: config.GITHUB_TOKEN },
      cacheToolsList: true,
    });
  }
  if (config.NOTION_API_KEY && allow("notion")) {
    specs.push({
      name: "notion",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${config.NOTION_API_KEY}`,
          "Notion-Version": "2022-06-28",
        }),
      },
      cacheToolsList: true,
    });
  }

  // Slack search — requires the xoxp user token.
  if (config.SLACK_USER_TOKEN && allow("slack-search")) {
    push("slack-search", "slack.js", { SLACK_USER_TOKEN: config.SLACK_USER_TOKEN });
  }

  // Google Workspace (Gmail, Calendar, Transcripts, Meet) — all-or-none OAuth.
  const hasGoogle =
    config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET && config.GOOGLE_REFRESH_TOKEN;
  if (hasGoogle) {
    const googleEnv = {
      GOOGLE_CLIENT_ID: config.GOOGLE_CLIENT_ID!,
      GOOGLE_CLIENT_SECRET: config.GOOGLE_CLIENT_SECRET!,
      GOOGLE_REFRESH_TOKEN: config.GOOGLE_REFRESH_TOKEN!,
    };
    if (allow("gmail")) push("gmail", "gmail.js", googleEnv);
    if (allow("google-calendar")) push("google-calendar", "calendar.js", googleEnv);
    if (allow("meeting-transcripts")) push("meeting-transcripts", "transcripts.js", googleEnv);
    if (allow("google-meet")) push("google-meet", "meet.js", googleEnv);
  }

  // Memory — registered UNCONDITIONALLY. The viewer scope is baked into the
  // child env so canView runs at the MCP edge. CRITICAL: the memory server reads
  // this scope once at module load (src/mcp/memory.ts), so a fresh server MUST
  // be spawned per request — never warm-pooled — or one user's scope would leak
  // into another's reply. The runner constructs+closes these per call.
  const memoryEnv: Record<string, string> = { SQLITE_DB_PATH: resolve(config.SQLITE_DB_PATH) };
  if (process.env.MEMORY_ACL_MODE) memoryEnv.MEMORY_ACL_MODE = process.env.MEMORY_ACL_MODE;
  if (process.env.MEMORY_SENSITIVE_RECALL) {
    memoryEnv.MEMORY_SENSITIVE_RECALL = process.env.MEMORY_SENSITIVE_RECALL;
  }
  if (process.env.MEMORY_ENTITY_GRAPH) memoryEnv.MEMORY_ENTITY_GRAPH = process.env.MEMORY_ENTITY_GRAPH;
  if (process.env.MEMORY_ENTITY_RESOLVE_MIN) {
    memoryEnv.MEMORY_ENTITY_RESOLVE_MIN = process.env.MEMORY_ENTITY_RESOLVE_MIN;
  }
  if (opts.viewer) Object.assign(memoryEnv, viewerScopeToEnv(opts.viewer));
  specs.push({
    name: "memory",
    command: "node",
    args: [distServer("memory.js")],
    env: memoryEnv,
    cacheToolsList: true,
  });

  return specs;
}

/**
 * Builds the (unconnected) MCPServerStdio instances for this request. The caller
 * (the agent runner) connect()s them before the run and close()s them in a
 * finally — including the per-request memory server, which must not outlive the
 * request (see resolveServerSpecs note on viewer-scope isolation).
 */
export function buildMcpServers(opts: BuildMcpServersOptions = {}): MCPServerStdio[] {
  const specs = resolveServerSpecs(opts);
  log.info({ servers: specs.map((s) => s.name) }, "Building MCP servers for agent run");
  return specs.map(
    (s) =>
      new MCPServerStdio({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
        cacheToolsList: s.cacheToolsList,
      })
  );
}
