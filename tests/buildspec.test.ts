import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The custom MCP servers run from dist/mcp/*.js at runtime (npm start runs
// dist/index.js). CI must therefore EMIT dist/ — `tsc --noEmit` alone catches
// type errors but never produces the artifacts the runtime needs, and never
// proves the emit step itself works. These tests assert the buildspec runs an
// emitting build before the test step.
describe("buildspec.yml CI pipeline", () => {
  const buildspec = readFileSync(join(process.cwd(), "buildspec.yml"), "utf8");

  // The pre_build phase is a YAML block; isolate it so ordering assertions are
  // about the right phase (and not, say, a Docker build line).
  function preBuildBlock(): string {
    const lines = buildspec.split("\n");
    const startIdx = lines.findIndex((l) => /^\s*pre_build:/.test(l));
    expect(startIdx).toBeGreaterThanOrEqual(0);
    // pre_build is indented under `phases:`; the next sibling phase (build:) is
    // at the same indentation. Capture everything until then.
    const indent = lines[startIdx].match(/^\s*/)?.[0].length ?? 0;
    const out: string[] = [];
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;
      if (line.trim() !== "" && lineIndent <= indent) break;
      out.push(line);
    }
    return out.join("\n");
  }

  it("emits dist/ in pre_build via `npm run build` (an emitting tsc)", () => {
    const block = preBuildBlock();
    // Either `npm run build` (which is `tsc`, emitting to dist) or a bare
    // emitting `tsc` invocation (i.e. NOT `tsc --noEmit`).
    const hasNpmBuild = /npm run build\b/.test(block);
    const hasEmittingTsc = /\btsc\b(?![^\n]*--noEmit)/.test(block);
    expect(hasNpmBuild || hasEmittingTsc).toBe(true);
  });

  it("runs the emitting build BEFORE `npm test` in pre_build", () => {
    const block = preBuildBlock();
    const buildIdx = (() => {
      const npm = block.search(/npm run build\b/);
      if (npm >= 0) return npm;
      return block.search(/\btsc\b(?![^\n]*--noEmit)/);
    })();
    const testIdx = block.search(/npm test\b/);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(testIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeLessThan(testIdx);
  });

  it("keeps the ECR login step in pre_build", () => {
    const block = preBuildBlock();
    expect(block).toMatch(/aws ecr get-login-password/);
  });
});

describe("buildspec.yml — dashboard image", () => {
  const buildspec = readFileSync(join(process.cwd(), "buildspec.yml"), "utf8");

  it("builds the dashboard image from Dockerfile.dashboard", () => {
    expect(buildspec).toMatch(/Dockerfile\.dashboard/);
  });

  it("builds and pushes a separate sentinel-dashboard image", () => {
    expect(buildspec).toMatch(/sentinel-dashboard/);
    expect(buildspec).toMatch(/docker push[^\n]*dashboard/i);
  });
});
