import { describe, it, expect } from "vitest";
import {
  classifyProcess,
  aggregateProcesses,
  type RawProcess,
} from "../src/metrics/aggregate.js";

describe("classifyProcess", () => {
  it("classifies the main sentinel process", () => {
    const p: RawProcess = {
      pid: 100,
      rssKb: 100_000,
      cpu: 1.0,
      command: "node /path/node_modules/.bin/tsx src/index.ts",
    };
    expect(classifyProcess(p)).toBe("sentinel-main");
  });

  it("classifies the tsx preflight inner node process", () => {
    const p: RawProcess = {
      pid: 100,
      rssKb: 100_000,
      cpu: 1.0,
      command:
        "/Users/x/.nvm/versions/node/v20.19.2/bin/node --require /Users/x/code/sentinel/node_modules/tsx/dist/preflight.cjs --import file:///Users/x/code/sentinel/src/index.ts",
    };
    expect(classifyProcess(p)).toBe("sentinel-main");
  });

  it("classifies a joiner process", () => {
    const p: RawProcess = {
      pid: 200,
      rssKb: 80_000,
      cpu: 0.5,
      command: "node /path/tsx src/meet-bot/joiner.ts https://meet.google.com/abc --duration 1800",
    };
    expect(classifyProcess(p)).toBe("meet-joiner");
  });

  it("classifies a Chrome main process by sentinel-chrome-profile", () => {
    const p: RawProcess = {
      pid: 300,
      rssKb: 200_000,
      cpu: 3.0,
      command:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/Users/x/sentinel/data/sentinel-chrome-profile",
    };
    expect(classifyProcess(p)).toBe("chrome-main");
  });

  it("classifies a Chrome renderer helper", () => {
    const p: RawProcess = {
      pid: 301,
      rssKb: 400_000,
      cpu: 5.0,
      command:
        "Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --user-data-dir=/path/sentinel-chrome-profile",
    };
    expect(classifyProcess(p)).toBe("chrome-renderer");
  });

  it("classifies a Chrome GPU helper", () => {
    const p: RawProcess = {
      pid: 302,
      rssKb: 100_000,
      cpu: 0.2,
      command:
        "Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU) --user-data-dir=/path/sentinel-chrome-profile",
    };
    expect(classifyProcess(p)).toBe("chrome-gpu");
  });

  it("classifies other sentinel-related Chrome helpers", () => {
    const p: RawProcess = {
      pid: 303,
      rssKb: 50_000,
      cpu: 0.1,
      command:
        "Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --user-data-dir=/path/sentinel-chrome-profile --utility-sub-type=network.mojom.NetworkService",
    };
    expect(classifyProcess(p)).toBe("chrome-helper");
  });

  it("returns null for unrelated processes", () => {
    const p: RawProcess = {
      pid: 999,
      rssKb: 100_000,
      cpu: 1.0,
      command: "/usr/bin/zsh",
    };
    expect(classifyProcess(p)).toBeNull();
  });
});

describe("aggregateProcesses", () => {
  const now = new Date("2026-04-22T00:45:00Z").toISOString();

  it("produces a full summary for a running meeting", () => {
    const procs: RawProcess[] = [
      { pid: 1, rssKb: 100_000, cpu: 1.0, command: "node /path/tsx src/index.ts" },
      { pid: 2, rssKb: 80_000, cpu: 0.5, command: "node /path/tsx src/meet-bot/joiner.ts https://meet.google.com/a --duration 1800" },
      { pid: 3, rssKb: 200_000, cpu: 3.0, command: "Google Chrome --user-data-dir=/path/sentinel-chrome-profile" },
      { pid: 4, rssKb: 400_000, cpu: 5.0, command: "Google Chrome Helper (Renderer) --user-data-dir=/path/sentinel-chrome-profile" },
      { pid: 5, rssKb: 100_000, cpu: 0.2, command: "Google Chrome Helper (GPU) --user-data-dir=/path/sentinel-chrome-profile" },
      { pid: 999, rssKb: 5_000_000, cpu: 10, command: "/usr/bin/unrelated" },
    ];
    const summary = aggregateProcesses(procs, now);

    expect(summary.timestamp).toBe(now);
    expect(summary.totalRssMb).toBeCloseTo(
      (100_000 + 80_000 + 200_000 + 400_000 + 100_000) / 1024,
      1
    );
    expect(summary.totalCpuPct).toBeCloseTo(1.0 + 0.5 + 3.0 + 5.0 + 0.2, 1);
    expect(summary.counts["sentinel-main"]).toBe(1);
    expect(summary.counts["meet-joiner"]).toBe(1);
    expect(summary.counts["chrome-main"]).toBe(1);
    expect(summary.counts["chrome-renderer"]).toBe(1);
    expect(summary.counts["chrome-gpu"]).toBe(1);
    expect(summary.activeMeetings).toBe(1);
    expect(summary.processes).toHaveLength(5); // 999 excluded
  });

  it("reports zero active meetings when no joiner is running", () => {
    const procs: RawProcess[] = [
      { pid: 1, rssKb: 100_000, cpu: 1.0, command: "node /path/tsx src/index.ts" },
    ];
    const summary = aggregateProcesses(procs, now);
    expect(summary.activeMeetings).toBe(0);
    expect(summary.counts["sentinel-main"]).toBe(1);
  });

  it("handles no sentinel processes at all", () => {
    const procs: RawProcess[] = [
      { pid: 999, rssKb: 100_000, cpu: 1.0, command: "/usr/bin/zsh" },
    ];
    const summary = aggregateProcesses(procs, now);
    expect(summary.totalRssMb).toBe(0);
    expect(summary.activeMeetings).toBe(0);
    expect(summary.processes).toHaveLength(0);
  });
});
