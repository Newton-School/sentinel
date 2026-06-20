import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Dockerfile runtime image", () => {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");

  it("uses the Playwright v1.59.1 base image for the runtime stage", () => {
    expect(dockerfile).toMatch(/mcr\.microsoft\.com\/playwright:v1\.59\.1/);
  });

  it("installs Google Chrome via Playwright in the runtime image", () => {
    expect(dockerfile).toMatch(/playwright install (--with-deps )?chrome/);
  });

  it("does NOT install the Claude CLI (migrated to the OpenAI Agents SDK)", () => {
    expect(dockerfile).not.toMatch(/@anthropic-ai\/claude-code/);
  });

  it("keeps the curl-based HEALTHCHECK against /health", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/curl -f http:\/\/localhost:8930\/health/);
  });

  it('keeps the CMD ["node", "dist/index.js"]', () => {
    expect(dockerfile).toMatch(/CMD \["node", "dist\/index\.js"\]/);
  });

  it("keeps the builder stage on node:20-alpine", () => {
    expect(dockerfile).toMatch(/FROM node:20-alpine AS builder/);
  });

  it("runs the runtime container as a non-root user", () => {
    expect(dockerfile).toMatch(/^USER\s+(?!root)\S+/m);
  });

  it("chowns /app (or /app/data) so the non-root user can write the volume", () => {
    expect(dockerfile).toMatch(/chown\s+(-R\s+)?\S+\s+\/app(\/data)?\b/);
  });

  it("uses dumb-init as PID 1 (zombie reaping + SIGTERM forwarding)", () => {
    expect(dockerfile).toMatch(/install[^\n]*\bdumb-init\b/);
    expect(dockerfile).toMatch(/ENTRYPOINT \["dumb-init", "--"\]/);
  });

  it("sets HOME for the Playwright/Chrome profile to resolve", () => {
    expect(dockerfile).toMatch(/ENV HOME=\/home\/pwuser/);
  });
});

describe(".dockerignore", () => {
  it("excludes secrets + local state from the build context", () => {
    const di = readFileSync(join(process.cwd(), ".dockerignore"), "utf8");
    for (const pat of [".env", "node_modules", "data/", "*.db", ".git"]) {
      expect(di, `.dockerignore should list ${pat}`).toContain(pat);
    }
  });
});
