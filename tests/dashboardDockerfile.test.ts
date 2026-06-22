import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Dockerfile.dashboard", () => {
  const df = readFileSync(join(process.cwd(), "Dockerfile.dashboard"), "utf8");

  it("builds on a slim node:20-alpine image, NOT the heavy Playwright base", () => {
    expect(df).toMatch(/FROM node:20-alpine AS builder/);
    expect(df).not.toMatch(/mcr\.microsoft\.com\/playwright/);
  });

  it("builds the SPA (dashboard-web) in the build stage", () => {
    expect(df).toMatch(/dashboard-web/);
    expect(df).toMatch(/npm (run )?--prefix dashboard-web|--prefix dashboard-web/);
  });

  it("does NOT download browsers (no playwright install)", () => {
    expect(df).not.toMatch(/playwright install/);
  });

  it("runs as a non-root user", () => {
    expect(df).toMatch(/^USER\s+(?!root)\S+/m);
  });

  it("serves the built SPA via DASHBOARD_STATIC_DIR", () => {
    expect(df).toMatch(/ENV DASHBOARD_STATIC_DIR=/);
  });

  it("HEALTHCHECKs the dashboard's own /api/health on 8940", () => {
    expect(df).toMatch(/HEALTHCHECK/);
    expect(df).toMatch(/curl -f http:\/\/localhost:8940\/api\/health/);
  });

  it("uses dumb-init as PID 1 and runs the dashboard entrypoint", () => {
    expect(df).toMatch(/ENTRYPOINT \["dumb-init", "--"\]/);
    expect(df).toMatch(/CMD \["node", "dist\/dashboard\/index\.js"\]/);
  });
});

describe(".dockerignore covers the SPA package", () => {
  const di = readFileSync(join(process.cwd(), ".dockerignore"), "utf8");
  it("excludes dashboard-web build artifacts + deps from the context", () => {
    expect(di).toMatch(/dashboard-web\/node_modules/);
    expect(di).toMatch(/dashboard-web\/dist/);
  });
});
