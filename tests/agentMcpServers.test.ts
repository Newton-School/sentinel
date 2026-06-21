import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ViewerScope } from "../src/access/scope.js";

// Hoisted so the vi.mock factories (themselves hoisted) can reference them.
const { cfg, stdioCtor } = vi.hoisted(() => ({
  cfg: {} as Record<string, unknown>,
  stdioCtor: vi.fn(),
}));

// Mutable config mock — set credential fields per test.
vi.mock("../src/config.js", () => ({ config: cfg }));

// Avoid pino reading config.LOG_LEVEL at logger module load.
vi.mock("../src/logging/logger.js", () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// MCPServerStdio is mocked so buildMcpServers can be asserted without the SDK
// spawning any subprocess. It captures the constructor options for assertions.
vi.mock("@openai/agents", () => ({
  MCPServerStdio: class {
    opts: unknown;
    constructor(opts: unknown) {
      this.opts = opts;
      stdioCtor(opts);
    }
  },
}));

import { resolveServerSpecs, buildMcpServers } from "../src/agent/mcpServers.js";

const reset = (over: Record<string, unknown> = {}): void => {
  for (const k of Object.keys(cfg)) delete cfg[k];
  cfg.DATABASE_URL = "postgres://localhost:5432/sentinel";
  Object.assign(cfg, over);
};

const names = (specs: { name: string }[]): string[] => specs.map((s) => s.name).sort();

describe("resolveServerSpecs", () => {
  beforeEach(() => {
    reset();
    stdioCtor.mockReset();
    // The memory server's connection string is baked from process.env.DATABASE_URL
    // (the child MCP subprocess connects to the same Postgres). Pin it so the env
    // assertion below is deterministic regardless of the worker's test DB url.
    process.env.DATABASE_URL = "postgres://localhost:5432/sentinel_test";
  });

  it("always includes the memory server, even with no credentials", () => {
    const specs = resolveServerSpecs();
    expect(names(specs)).toEqual(["memory"]);
    const memory = specs.find((s) => s.name === "memory")!;
    expect(memory.command).toBe("node");
    expect(memory.args[0]).toMatch(/dist\/mcp\/memory\.js$/);
    // The memory child connects to the same Postgres via DATABASE_URL.
    expect(memory.env.DATABASE_URL).toBe("postgres://localhost:5432/sentinel_test");
  });

  it("SECURITY: bakes the request's viewer scope into the memory server env", () => {
    const viewer: ViewerScope = {
      userId: "U42",
      role: "founder",
      entityId: 7,
      teamIds: [1, 2],
      allowedTiers: new Set(["founders"]),
    };
    const memory = resolveServerSpecs({ viewer }).find((s) => s.name === "memory")!;
    expect(memory.env.MEMORY_VIEWER_USER_ID).toBe("U42");
    expect(memory.env.MEMORY_VIEWER_ROLE).toBe("founder");
    expect(memory.env.MEMORY_VIEWER_TEAM_IDS).toBe("1,2");
    expect(memory.env.MEMORY_VIEWER_ENTITY_ID).toBe("7");
  });

  it("omits the viewer env entirely when no viewer is passed", () => {
    const memory = resolveServerSpecs().find((s) => s.name === "memory")!;
    expect(memory.env.MEMORY_VIEWER_ROLE).toBeUndefined();
  });

  it("gates Metabase on URL + API key, and uses the API-key env", () => {
    reset({ METABASE_URL: "https://mb.example.com", METABASE_API_KEY: "mb-key" });
    const specs = resolveServerSpecs();
    expect(names(specs)).toEqual(["memory", "metabase"]);
    const mb = specs.find((s) => s.name === "metabase")!;
    expect(mb.env).toEqual({ METABASE_URL: "https://mb.example.com", METABASE_API_KEY: "mb-key" });
  });

  it("gates Metabase on URL + username/password when no API key", () => {
    reset({ METABASE_URL: "https://mb.example.com", METABASE_USERNAME: "a@b.co", METABASE_PASSWORD: "pw" });
    const mb = resolveServerSpecs().find((s) => s.name === "metabase");
    expect(mb).toBeDefined();
    expect(mb!.env.METABASE_USERNAME).toBe("a@b.co");
    expect(mb!.env.METABASE_PASSWORD).toBe("pw");
    expect(mb!.env.METABASE_API_KEY).toBeUndefined();
  });

  it("disables Metabase when only the URL is set", () => {
    reset({ METABASE_URL: "https://mb.example.com" });
    expect(names(resolveServerSpecs())).toEqual(["memory"]);
  });

  it("registers GitHub (npx) and Notion (npx) when their tokens are set", () => {
    reset({ GITHUB_TOKEN: "ghp_x", NOTION_API_KEY: "ntn_y" });
    const specs = resolveServerSpecs();
    const gh = specs.find((s) => s.name === "github")!;
    expect(gh.command).toBe("npx");
    expect(gh.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(gh.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_x");
    const notion = specs.find((s) => s.name === "notion")!;
    expect(notion.command).toBe("npx");
    expect(notion.env.OPENAPI_MCP_HEADERS).toContain("Bearer ntn_y");
  });

  it("registers all four Google servers when all three OAuth vars are set", () => {
    reset({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "sec", GOOGLE_REFRESH_TOKEN: "ref" });
    expect(names(resolveServerSpecs())).toEqual([
      "gmail",
      "google-calendar",
      "google-meet",
      "meeting-transcripts",
      "memory",
    ]);
  });

  it("registers no Google servers when the OAuth vars are absent", () => {
    reset({ GITHUB_TOKEN: "ghp_x" });
    expect(names(resolveServerSpecs())).toEqual(["github", "memory"]);
  });

  it("honors the allowlist: only listed servers (+ always-on memory) are emitted", () => {
    reset({
      METABASE_URL: "https://mb.example.com",
      METABASE_API_KEY: "k",
      GITHUB_TOKEN: "ghp_x",
      NOTION_API_KEY: "ntn_y",
    });
    const specs = resolveServerSpecs({ servers: new Set(["metabase"]) });
    expect(names(specs)).toEqual(["memory", "metabase"]);
  });
});

describe("buildMcpServers", () => {
  beforeEach(() => {
    reset({ METABASE_URL: "https://mb.example.com", METABASE_API_KEY: "k" });
    stdioCtor.mockReset();
  });

  it("constructs one MCPServerStdio per spec with its command/args/env", () => {
    const servers = buildMcpServers();
    expect(servers).toHaveLength(2); // metabase + memory
    expect(stdioCtor).toHaveBeenCalledTimes(2);
    const built = stdioCtor.mock.calls.map((c) => c[0] as { name: string; command: string });
    expect(built.map((o) => o.name).sort()).toEqual(["memory", "metabase"]);
    for (const o of built) expect(o.command).toBe("node");
  });
});
