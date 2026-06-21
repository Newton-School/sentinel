import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import type { z } from "zod";

// Importing src/config.ts runs loadConfig() at module load, which calls
// process.exit(1) if process.env is invalid. So we set a VALID baseline env
// here BEFORE importing, and import the module DYNAMICALLY (never statically —
// a static top-of-file import would trigger the import-time process.exit).
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.BOT_USER_ID = "U123";
process.env.ALLOWED_USER_IDS = "U123"; // non-empty so the ALLOWED_USER_IDS refine passes
// An OpenAI key is required — provide one so the import-time loadConfig() succeeds.
process.env.MEMORY_EMBEDDING_API_KEY = "sk-test-embed";
// No Google vars set, so the all-or-none Google refine passes.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let envSchema: z.ZodType<any>;
let loadConfig: () => unknown;

beforeAll(async () => {
  const mod = await import("../src/config.js");
  envSchema = mod.envSchema;
  loadConfig = mod.loadConfig;
});

describe("config envSchema (real module)", () => {
  const validEnv = {
    SLACK_BOT_TOKEN: "xoxb-test-token",
    SLACK_APP_TOKEN: "xapp-test-token",
    BOT_USER_ID: "U123456",
    OPENAI_API_KEY: "sk-openai-test",
    METABASE_URL: "https://metabase.example.com",
    METABASE_USERNAME: "admin@test.com",
    METABASE_PASSWORD: "password",
    GITHUB_TOKEN: "ghp_test",
    NOTION_API_KEY: "ntn_test",
    ALLOWED_USER_IDS: "U123,U456",
  };

  it("parses valid env correctly with expected defaults", () => {
    const result = envSchema.safeParse(validEnv);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ALLOWED_USER_IDS).toEqual(["U123", "U456"]);
      expect(result.data.LOG_LEVEL).toBe("info");
      expect(result.data.PG_POOL_MAX).toBe(10);
      expect(result.data.OPENAI_REPLY_MODEL).toMatch(/^gpt-5/);
    }
  });

  describe("HEALTH_CHECK_PORT", () => {
    it("defaults to 8930 when unset", () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HEALTH_CHECK_PORT).toBe(8930);
      }
    });

    it("coerces a numeric string to a number", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        HEALTH_CHECK_PORT: "3000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.HEALTH_CHECK_PORT).toBe(3000);
        expect(typeof result.data.HEALTH_CHECK_PORT).toBe("number");
      }
    });

    it("rejects a non-numeric string", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        HEALTH_CHECK_PORT: "not-a-port",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("Slack token prefix checks", () => {
    it("rejects invalid SLACK_BOT_TOKEN prefix", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SLACK_BOT_TOKEN: "bad-token",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid SLACK_APP_TOKEN prefix", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SLACK_APP_TOKEN: "bad-token",
      });
      expect(result.success).toBe(false);
    });

    it("accepts valid SLACK_USER_TOKEN with xoxp- prefix", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SLACK_USER_TOKEN: "xoxp-test-user-token",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.SLACK_USER_TOKEN).toBe("xoxp-test-user-token");
      }
    });

    it("rejects SLACK_USER_TOKEN with wrong prefix", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        SLACK_USER_TOKEN: "xoxb-wrong-prefix",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("ALLOWED_USER_IDS splitting", () => {
    it("splits a comma-separated list", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        ALLOWED_USER_IDS: "U123,U456",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALLOWED_USER_IDS).toEqual(["U123", "U456"]);
      }
    });

    it("trims whitespace and drops empties", () => {
      const result = envSchema.safeParse({
        ...validEnv,
        ALLOWED_USER_IDS: " U111 , U222 , U333 ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALLOWED_USER_IDS).toEqual(["U111", "U222", "U333"]);
      }
    });
  });

  describe("LOG_LEVEL", () => {
    it("defaults to info", () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LOG_LEVEL).toBe("info");
      }
    });

    it("accepts a valid enum value", () => {
      const result = envSchema.safeParse({ ...validEnv, LOG_LEVEL: "debug" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.LOG_LEVEL).toBe("debug");
      }
    });

    it("rejects an out-of-enum value", () => {
      const result = envSchema.safeParse({ ...validEnv, LOG_LEVEL: "verbose" });
      expect(result.success).toBe(false);
    });
  });

  describe("access group (SENTINEL_ACCESS_GROUP_HANDLE / SENTINEL_OWNER_USER_ID)", () => {
    it("defaults SENTINEL_ACCESS_GROUP_HANDLE to 'sentinel-access-group'", () => {
      const r = envSchema.safeParse(validEnv);
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.SENTINEL_ACCESS_GROUP_HANDLE).toBe("sentinel-access-group");
        expect(r.data.SENTINEL_OWNER_USER_ID).toBeUndefined();
      }
    });

    it("accepts overrides for handle + owner id", () => {
      const r = envSchema.safeParse({
        ...validEnv,
        SENTINEL_ACCESS_GROUP_HANDLE: "data-team",
        SENTINEL_OWNER_USER_ID: "U05EUC842KD",
      });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.SENTINEL_ACCESS_GROUP_HANDLE).toBe("data-team");
        expect(r.data.SENTINEL_OWNER_USER_ID).toBe("U05EUC842KD");
      }
    });
  });

  describe("ANALYTICS_MODEL", () => {
    it("defaults ANALYTICS_MODEL to undefined when unset", () => {
      const result = envSchema.safeParse(validEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ANALYTICS_MODEL).toBeUndefined();
      }
    });

    it("accepts an optional ANALYTICS_MODEL override", () => {
      const r = envSchema.safeParse({ ...validEnv, ANALYTICS_MODEL: "gpt-5.4" });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.ANALYTICS_MODEL).toBe("gpt-5.4");
    });
  });

  describe("optional Metabase/GitHub/Notion/Google fields", () => {
    // An OpenAI key is always required now; MEMORY_EMBEDDING_API_KEY satisfies it
    // without setting OPENAI_API_KEY, so the "optional unset" assertions still hold.
    const minimalEnv = {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_APP_TOKEN: "xapp-test-token",
      BOT_USER_ID: "U123456",
      ALLOWED_USER_IDS: "U123",
      MEMORY_EMBEDDING_API_KEY: "sk-embed",
    };

    it("parses with only required Slack vars (everything optional unset)", () => {
      const result = envSchema.safeParse(minimalEnv);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.OPENAI_API_KEY).toBeUndefined();
        expect(result.data.METABASE_URL).toBeUndefined();
        expect(result.data.GITHUB_TOKEN).toBeUndefined();
        expect(result.data.NOTION_API_KEY).toBeUndefined();
        expect(result.data.SLACK_USER_TOKEN).toBeUndefined();
        expect(result.data.GOOGLE_CLIENT_ID).toBeUndefined();
        expect(result.data.GOOGLE_CLIENT_SECRET).toBeUndefined();
        expect(result.data.GOOGLE_REFRESH_TOKEN).toBeUndefined();
      }
    });

    it("accepts Metabase vars when provided", () => {
      const result = envSchema.safeParse({
        ...minimalEnv,
        METABASE_URL: "https://metabase.example.com",
        METABASE_USERNAME: "admin@test.com",
        METABASE_PASSWORD: "pass",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.METABASE_URL).toBe("https://metabase.example.com");
      }
    });

    it("rejects an invalid METABASE_URL when provided", () => {
      const result = envSchema.safeParse({
        ...minimalEnv,
        METABASE_URL: "not-a-url",
      });
      expect(result.success).toBe(false);
    });

    it("accepts GITHUB_TOKEN and NOTION_API_KEY when provided", () => {
      const result = envSchema.safeParse({
        ...minimalEnv,
        GITHUB_TOKEN: "ghp_test",
        NOTION_API_KEY: "ntn_test",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.GITHUB_TOKEN).toBe("ghp_test");
        expect(result.data.NOTION_API_KEY).toBe("ntn_test");
      }
    });

    it("accepts all three Google credentials together", () => {
      const result = envSchema.safeParse({
        ...minimalEnv,
        GOOGLE_CLIENT_ID: "client-id",
        GOOGLE_CLIENT_SECRET: "client-secret",
        GOOGLE_REFRESH_TOKEN: "refresh-token",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.GOOGLE_CLIENT_ID).toBe("client-id");
        expect(result.data.GOOGLE_CLIENT_SECRET).toBe("client-secret");
        expect(result.data.GOOGLE_REFRESH_TOKEN).toBe("refresh-token");
      }
    });
  });
});

describe("loadConfig (real module)", () => {
  // Snapshot the baseline valid env so each test can restore it.
  const baselineEnv = { ...process.env };

  afterEach(() => {
    // Restore process.env to the valid baseline and clear any spies.
    for (const key of Object.keys(process.env)) {
      if (!(key in baselineEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, baselineEnv);
    vi.restoreAllMocks();
  });

  it("returns a parsed config object on the success path", () => {
    const result = loadConfig() as Record<string, unknown>;
    expect(result.SLACK_BOT_TOKEN).toBe("xoxb-test");
    expect(result.SLACK_APP_TOKEN).toBe("xapp-test");
    expect(result.BOT_USER_ID).toBe("U123");
    expect(result.ALLOWED_USER_IDS).toEqual(["U123"]);
    expect(result.LOG_LEVEL).toBe("info");
    expect(result.HEALTH_CHECK_PORT).toBe(8930);
    // DATABASE_URL passes through from the env (tests/setup.ts sets the
    // per-worker test URL); PG_POOL_MAX defaults to 10.
    expect(result.DATABASE_URL).toBe(process.env.DATABASE_URL);
    expect(result.PG_POOL_MAX).toBe(10);
  });

  it("calls process.exit(1) and console.error on an invalid config", () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Make the config invalid by removing a required field.
    delete process.env.SLACK_BOT_TOKEN;

    // process.exit is stubbed, so loadConfig falls through to `return result.data`
    // where result is the failed parse — we only assert on the side effects.
    try {
      loadConfig();
    } catch {
      // safeParse failure path may throw when reading result.data after the
      // stubbed exit; the side-effect assertions below are what matter.
    }

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();
  });
});
