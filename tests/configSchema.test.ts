import { describe, it, expect, beforeAll } from "vitest";
import type { z } from "zod";

// Importing src/config.ts runs loadConfig() at module load, which calls
// process.exit(1) if process.env is invalid. So we set a VALID baseline env
// here BEFORE importing, and import the schema DYNAMICALLY (never statically).
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_APP_TOKEN = "xapp-test";
process.env.BOT_USER_ID = "U123";
process.env.ALLOWED_USER_IDS = "U123"; // non-empty so refine A passes
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
  const base = {
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
    BOT_USER_ID: "U123",
    ALLOWED_USER_IDS: "U123",
  };

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
