import { describe, it, expect, vi } from "vitest";

/** Load the dashboard pool module with a mocked config. */
async function load(cfg: Record<string, unknown>) {
  vi.resetModules();
  vi.doMock("../../src/config.js", () => ({ config: cfg }));
  return import("../../src/dashboard/pool.js");
}

describe("dashboard read-only pool URL resolution", () => {
  it("prefers the dedicated SELECT-only URL when both are set", async () => {
    const { resolveReadOnlyDbUrl } = await load({
      DATABASE_URL_READONLY: "postgres://ro@db/sentinel",
      DATABASE_URL: "postgres://rw@db/sentinel",
      PG_POOL_MAX: 5,
    });
    expect(resolveReadOnlyDbUrl()).toBe("postgres://ro@db/sentinel");
  });

  it("falls back to DATABASE_URL for local dev", async () => {
    const { resolveReadOnlyDbUrl } = await load({ DATABASE_URL: "postgres://rw@db/sentinel", PG_POOL_MAX: 5 });
    expect(resolveReadOnlyDbUrl()).toBe("postgres://rw@db/sentinel");
  });

  it("throws when neither URL is configured", async () => {
    const { resolveReadOnlyDbUrl } = await load({ PG_POOL_MAX: 5 });
    expect(() => resolveReadOnlyDbUrl()).toThrow(/DATABASE_URL/);
  });
});
