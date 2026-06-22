import { describe, it, expect, beforeAll } from "vitest";
import type { z } from "zod";

// Importing src/config.ts runs loadConfig() at module load, which calls
// process.exit(1) if process.env is invalid. So we set a VALID baseline env
// here BEFORE importing, and import the schema DYNAMICALLY (never statically).
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.BOT_USER_ID = "U123";
process.env.ALLOWED_USER_IDS = "U123"; // non-empty so refine A passes
// An OpenAI key is required — provide one so the import-time loadConfig() succeeds.
process.env.MEMORY_EMBEDDING_API_KEY = "sk-test-embed";
// No Google vars set, so refine B (all-or-none) passes.
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let envSchema: z.ZodType<any>;

beforeAll(async () => {
  const mod = await import("../src/config.js");
  envSchema = mod.envSchema;
});

describe("real envSchema validation", () => {
  // An OpenAI key is always required — include one in the shared base so
  // success-expecting cases pass. baseNoKey drops it for the key-requirement test.
  const base = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    BOT_USER_ID: "U123",
    ALLOWED_USER_IDS: "U123",
    MEMORY_EMBEDDING_API_KEY: "sk-test-embed",
  };
  const { MEMORY_EMBEDDING_API_KEY: _omitKey, ...baseNoKey } = base;

  describe("ALLOWED_USER_IDS must be non-empty", () => {
    it("fails when ALLOWED_USER_IDS is empty string", () => {
      const result = envSchema.safeParse({ ...base, ALLOWED_USER_IDS: "" });
      expect(result.success).toBe(false);
    });

    it("fails when ALLOWED_USER_IDS is whitespace/commas only", () => {
      const result = envSchema.safeParse({ ...base, ALLOWED_USER_IDS: " , " });
      expect(result.success).toBe(false);
    });

    it("succeeds and parses a non-empty list", () => {
      const result = envSchema.safeParse({
        ...base,
        ALLOWED_USER_IDS: "U1,U2",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.ALLOWED_USER_IDS).toEqual(["U1", "U2"]);
      }
    });
  });

  describe("agent config + OpenAI key requirement", () => {
    it("defaults OPENAI_REPLY_MODEL to a GPT-5-class model", () => {
      const result = envSchema.safeParse({ ...base });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.OPENAI_REPLY_MODEL).toMatch(/^gpt-5/);
    });

    it("requires an OpenAI key", () => {
      const result = envSchema.safeParse({ ...baseNoKey });
      expect(result.success).toBe(false);
    });

    it("accepts OPENAI_API_KEY as the key", () => {
      const result = envSchema.safeParse({ ...baseNoKey, OPENAI_API_KEY: "sk-x" });
      expect(result.success).toBe(true);
    });

    it("accepts MEMORY_EMBEDDING_API_KEY as the fallback key", () => {
      const result = envSchema.safeParse({ ...baseNoKey, MEMORY_EMBEDDING_API_KEY: "sk-y" });
      expect(result.success).toBe(true);
    });

    it("coerces and defaults AGENT_MAX_TURNS", () => {
      const result = envSchema.safeParse({ ...base });
      if (result.success) expect(result.data.AGENT_MAX_TURNS).toBe(12);
      const overridden = envSchema.safeParse({ ...base, AGENT_MAX_TURNS: "7" });
      if (overridden.success) expect(overridden.data.AGENT_MAX_TURNS).toBe(7);
    });

    it("defaults DASHBOARD_PORT to 8940 and coerces an override", () => {
      const def = envSchema.safeParse({ ...base });
      if (def.success) expect(def.data.DASHBOARD_PORT).toBe(8940);
      const over = envSchema.safeParse({ ...base, DASHBOARD_PORT: "9001" });
      if (over.success) expect(over.data.DASHBOARD_PORT).toBe(9001);
    });

    it("accepts an optional read-only database URL for the dashboard", () => {
      const none = envSchema.safeParse({ ...base });
      if (none.success) expect(none.data.DATABASE_URL_READONLY).toBeUndefined();
      const set = envSchema.safeParse({ ...base, DATABASE_URL_READONLY: "postgres://ro@db/sentinel" });
      expect(set.success).toBe(true);
      if (set.success) expect(set.data.DATABASE_URL_READONLY).toBe("postgres://ro@db/sentinel");
    });

    it("parses GENERAL_MCP_SERVERS into a set (or leaves it undefined)", () => {
      const none = envSchema.safeParse({ ...base });
      if (none.success) expect(none.data.GENERAL_MCP_SERVERS).toBeUndefined();

      const set = envSchema.safeParse({ ...base, GENERAL_MCP_SERVERS: "metabase, memory ,github" });
      expect(set.success).toBe(true);
      if (set.success) {
        expect(set.data.GENERAL_MCP_SERVERS).toBeInstanceOf(Set);
        expect([...(set.data.GENERAL_MCP_SERVERS as Set<string>)].sort()).toEqual([
          "github",
          "memory",
          "metabase",
        ]);
      }
    });
  });

  describe("Google OAuth creds are all-or-none", () => {
    it("succeeds when all three Google vars are set", () => {
      const result = envSchema.safeParse({
        ...base,
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REFRESH_TOKEN: "token",
      });
      expect(result.success).toBe(true);
    });

    it("succeeds when none of the Google vars are set", () => {
      const result = envSchema.safeParse({ ...base });
      expect(result.success).toBe(true);
    });

    it("fails when exactly one Google var is set", () => {
      const result = envSchema.safeParse({
        ...base,
        GOOGLE_CLIENT_ID: "id",
      });
      expect(result.success).toBe(false);
    });

    it("fails when exactly two Google vars are set", () => {
      const result = envSchema.safeParse({
        ...base,
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
      });
      expect(result.success).toBe(false);
    });
  });
});
