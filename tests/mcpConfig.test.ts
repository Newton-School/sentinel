import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// Mock pino
vi.mock("pino", () => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop, child: () => logger };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

// Isolate tests from the shared tmpdir so they can't pollute a real
// Sentinel mcp-config.json used by a running process.
const TEST_MCP_DIR = mkdtempSync(join(tmpdir(), "sentinel-mcp-test-"));
beforeAll(() => {
  process.env.SENTINEL_MCP_TMPDIR = TEST_MCP_DIR;
});
afterAll(() => {
  delete process.env.SENTINEL_MCP_TMPDIR;
  rmSync(TEST_MCP_DIR, { recursive: true, force: true });
});

describe("getUnavailableSources", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports all optional sources as unavailable when no optional env vars set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toContain("Slack search");
    expect(unavailable).toContain("Gmail");
    expect(unavailable).toContain("Google Calendar");
    expect(unavailable).toContain("Meeting Transcripts");
    expect(unavailable).toContain("Google Meet");
    expect(unavailable).toHaveLength(5);
  });

  it("reports no unavailable sources when all optional vars are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: "xoxp-test",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toHaveLength(0);
  });

  it("reports only Google sources when Slack token is set but Google is not", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: "xoxp-test",
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).not.toContain("Slack search");
    expect(unavailable).toContain("Gmail");
    expect(unavailable).toContain("Google Calendar");
    expect(unavailable).toContain("Meeting Transcripts");
    expect(unavailable).toContain("Google Meet");
    expect(unavailable).toHaveLength(4);
  });

  it("reports only Slack when Google is set but Slack token is not", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toEqual(["Slack search"]);
  });

  it("reports Metabase as unavailable when METABASE_URL is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: "xoxp-test",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toContain("Metabase");
  });

  it("reports GitHub as unavailable when GITHUB_TOKEN is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: "xoxp-test",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toContain("GitHub");
  });

  it("reports Notion as unavailable when NOTION_API_KEY is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: "xoxp-test",
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    const unavailable = getUnavailableSources();

    expect(unavailable).toContain("Notion");
  });
});

describe("getMcpConfigPath", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes metabase, github, and notion when their credentials are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).toHaveProperty("metabase");
    expect(config.mcpServers).toHaveProperty("github");
    expect(config.mcpServers).toHaveProperty("notion");
  });

  it("includes slack-search server when SLACK_USER_TOKEN is set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: "xoxp-test-token",
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).toHaveProperty("slack-search");
    expect(config.mcpServers["slack-search"].env.SLACK_USER_TOKEN).toBe("xoxp-test-token");
  });

  it("excludes slack-search server when SLACK_USER_TOKEN is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("slack-search");
  });

  it("includes Google servers when all Google credentials are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).toHaveProperty("gmail");
    expect(config.mcpServers).toHaveProperty("google-calendar");
    expect(config.mcpServers).toHaveProperty("meeting-transcripts");
    expect(config.mcpServers).toHaveProperty("google-meet");

    // Verify Google env vars are passed
    expect(config.mcpServers.gmail.env.GOOGLE_CLIENT_ID).toBe("client-id");
    expect(config.mcpServers["google-calendar"].env.GOOGLE_CLIENT_SECRET).toBe("client-secret");
    expect(config.mcpServers["meeting-transcripts"].env.GOOGLE_REFRESH_TOKEN).toBe("refresh-token");
    expect(config.mcpServers["google-meet"].env.GOOGLE_CLIENT_ID).toBe("client-id");
  });

  it("excludes Google servers when Google credentials are missing", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("gmail");
    expect(config.mcpServers).not.toHaveProperty("google-calendar");
    expect(config.mcpServers).not.toHaveProperty("meeting-transcripts");
    expect(config.mcpServers).not.toHaveProperty("google-meet");
  });

  it("excludes Google servers when only partial credentials are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: undefined, // Missing
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("gmail");
    expect(config.mcpServers).not.toHaveProperty("google-calendar");
    expect(config.mcpServers).not.toHaveProperty("meeting-transcripts");
    expect(config.mcpServers).not.toHaveProperty("google-meet");
  });

  it("excludes metabase when METABASE_URL is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("metabase");
  });

  it("excludes github when GITHUB_TOKEN is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("github");
  });

  it("excludes notion when NOTION_API_KEY is not set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).not.toHaveProperty("notion");
  });

  it("registers only Google servers when only Google credentials are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).toHaveProperty("gmail");
    expect(config.mcpServers).toHaveProperty("google-calendar");
    expect(config.mcpServers).toHaveProperty("meeting-transcripts");
    expect(config.mcpServers).toHaveProperty("google-meet");
    expect(config.mcpServers).not.toHaveProperty("metabase");
    expect(config.mcpServers).not.toHaveProperty("github");
    expect(config.mcpServers).not.toHaveProperty("notion");
  });
});

describe("memory MCP server registration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("registers the memory server even when NO other credentials are set", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers).toHaveProperty("memory");
  });

  it("runs the compiled server via node dist/mcp/memory.js", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    expect(config.mcpServers.memory.command).toBe("node");
    const args = config.mcpServers.memory.args as string[];
    expect(args).toHaveLength(1);
    expect(args[0].endsWith(join("dist", "mcp", "memory.js"))).toBe(true);
  });

  it("passes SQLITE_DB_PATH as an ABSOLUTE path (the CLI child's cwd may differ)", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();
    const config = JSON.parse(readFileSync(configPath, "utf-8"));

    const dbPath = config.mcpServers.memory.env.SQLITE_DB_PATH as string;
    expect(isAbsolute(dbPath)).toBe(true);
    expect(dbPath).toBe(resolve("./sentinel.db"));
  });

  it("embeds the per-request viewer scope in the memory server env", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined, METABASE_USERNAME: undefined, METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined, NOTION_API_KEY: undefined, SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));
    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const { buildViewerScope } = await import("../src/access/scope.js");
    const viewer = buildViewerScope("U1", { founderUserIds: ["U1"], teamIds: [5] });
    const configPath = getMcpConfigPath({ viewer });
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const env = config.mcpServers.memory.env;
    expect(env.MEMORY_VIEWER_ROLE).toBe("founder");
    expect(env.MEMORY_VIEWER_USER_ID).toBe("U1");
    expect(env.MEMORY_VIEWER_TEAM_IDS).toBe("5");
  });

  it("omits viewer env when no viewer is passed (warm-up / pre-scoped)", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined, METABASE_USERNAME: undefined, METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined, NOTION_API_KEY: undefined, SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined, GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));
    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const config = JSON.parse(readFileSync(getMcpConfigPath(), "utf-8"));
    expect(config.mcpServers.memory.env).not.toHaveProperty("MEMORY_VIEWER_ROLE");
  });

  it("never reports Memory in getUnavailableSources (it is never unavailable)", async () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: undefined,
        METABASE_USERNAME: undefined,
        METABASE_PASSWORD: undefined,
        GITHUB_TOKEN: undefined,
        NOTION_API_KEY: undefined,
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));

    const { getUnavailableSources } = await import("../src/claude/mcpConfig.js");
    expect(getUnavailableSources()).not.toContain("Memory");
  });
});

describe("mcp-config secret file permissions and cleanup", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const mockConfigWithCreds = () => {
    vi.doMock("../src/config.js", () => ({
      config: {
        METABASE_URL: "https://metabase.test",
        METABASE_USERNAME: "admin",
        METABASE_PASSWORD: "super-secret-pass",
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
        SLACK_USER_TOKEN: undefined,
        GOOGLE_CLIENT_ID: undefined,
        GOOGLE_CLIENT_SECRET: undefined,
        GOOGLE_REFRESH_TOKEN: undefined,
        SQLITE_DB_PATH: "./sentinel.db",
      },
    }));
  };

  it("writes the mcp config file with owner-only (0600) permissions", async () => {
    mockConfigWithCreds();

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");
    const configPath = getMcpConfigPath();

    const mode = statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns a UNIQUE path per call, each existing with 0600 permissions", async () => {
    mockConfigWithCreds();

    const { getMcpConfigPath } = await import("../src/claude/mcpConfig.js");

    // Each call must yield a distinct file so that a write racing the Claude
    // CLI's read of a previous spawn's file can't produce a torn/partial JSON.
    const firstPath = getMcpConfigPath();
    const secondPath = getMcpConfigPath();

    expect(secondPath).not.toBe(firstPath);

    // Both files exist with owner-only (0600) perms.
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
    expect(statSync(firstPath).mode & 0o777).toBe(0o600);
    expect(statSync(secondPath).mode & 0o777).toBe(0o600);
  });

  it("removeMcpConfig deletes a specific file, and is a no-op when absent", async () => {
    mockConfigWithCreds();

    const { getMcpConfigPath, removeMcpConfig } = await import(
      "../src/claude/mcpConfig.js"
    );

    const pathA = getMcpConfigPath();
    const pathB = getMcpConfigPath();
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);

    // Removing one path leaves the other untouched.
    removeMcpConfig(pathA);
    expect(existsSync(pathA)).toBe(false);
    expect(existsSync(pathB)).toBe(true);

    // Calling again on the already-removed path must not throw.
    expect(() => removeMcpConfig(pathA)).not.toThrow();
    expect(existsSync(pathA)).toBe(false);
  });

  it("cleanupMcpConfig removes ALL mcp-config*.json files in the tmpdir", async () => {
    mockConfigWithCreds();

    const { getMcpConfigPath, cleanupMcpConfig } = await import(
      "../src/claude/mcpConfig.js"
    );

    // Generate several per-spawn config files.
    const paths = [getMcpConfigPath(), getMcpConfigPath(), getMcpConfigPath()];
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
    }

    cleanupMcpConfig();

    // Every per-spawn file is gone...
    for (const p of paths) {
      expect(existsSync(p)).toBe(false);
    }
    // ...and no mcp-config*.json orphans remain in the tmpdir.
    const remaining = readdirSync(TEST_MCP_DIR).filter(
      (f) => f.startsWith("mcp-config") && f.endsWith(".json")
    );
    expect(remaining).toHaveLength(0);

    // Calling again when nothing is left must not throw.
    expect(() => cleanupMcpConfig()).not.toThrow();
  });
});
