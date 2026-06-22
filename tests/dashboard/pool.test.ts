import { describe, it, expect } from "vitest";
import { loadDashboardEnv } from "../../src/dashboard/env.js";
import { resolveReadOnlyDbUrl } from "../../src/dashboard/pool.js";

describe("dashboard env", () => {
  it("applies defaults and coerces numbers", () => {
    const env = loadDashboardEnv({} as NodeJS.ProcessEnv);
    expect(env.DASHBOARD_PORT).toBe(8940);
    expect(env.PG_POOL_MAX).toBe(10);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_URL_READONLY).toBeUndefined();
    const over = loadDashboardEnv({ DASHBOARD_PORT: "9001", PG_POOL_MAX: "20" } as unknown as NodeJS.ProcessEnv);
    expect(over.DASHBOARD_PORT).toBe(9001);
    expect(over.PG_POOL_MAX).toBe(20);
  });

  it("does NOT require any of the bot's Slack/OpenAI secrets", () => {
    // The whole point: the dashboard pod parses fine with only DB env present.
    expect(() => loadDashboardEnv({ DATABASE_URL_READONLY: "postgres://ro@db/s" } as unknown as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe("dashboard read-only pool URL resolution", () => {
  it("prefers the dedicated SELECT-only URL when both are set", () => {
    expect(
      resolveReadOnlyDbUrl({ DATABASE_URL_READONLY: "postgres://ro@db/s", DATABASE_URL: "postgres://rw@db/s" })
    ).toBe("postgres://ro@db/s");
  });

  it("falls back to DATABASE_URL for local dev", () => {
    expect(resolveReadOnlyDbUrl({ DATABASE_URL_READONLY: undefined, DATABASE_URL: "postgres://rw@db/s" })).toBe(
      "postgres://rw@db/s"
    );
  });

  it("throws when neither URL is configured", () => {
    expect(() => resolveReadOnlyDbUrl({ DATABASE_URL_READONLY: undefined, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
  });
});
