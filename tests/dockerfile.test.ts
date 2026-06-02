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

  it("still installs the claude-code CLI globally", () => {
    expect(dockerfile).toMatch(/npm install -g @anthropic-ai\/claude-code/);
  });

  it("keeps the curl-based HEALTHCHECK against /health", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK/);
    expect(dockerfile).toMatch(/curl -f http:\/\/localhost:8080\/health/);
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
});
