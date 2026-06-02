import { describe, it, expect, vi } from "vitest";

// watcher.ts imports ../config.js, whose top-level loadConfig() calls
// process.exit(1) on invalid env. Mock it so importing the module is safe.
vi.mock("../src/config.js", () => ({
  config: {
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    GOOGLE_REFRESH_TOKEN: "grefresh",
  },
}));

// Silence pino structured logging pulled in via the watcher's logger.
vi.mock("pino", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
    trace: noop,
    child: () => logger,
  };
  const pino = () => logger;
  pino.stdTimeFunctions = { isoTime: () => "" };
  return { default: pino };
});

const { buildJoinerArgs } = await import("../src/meet-bot/watcher.js");

describe("buildJoinerArgs", () => {
  const base = {
    meetUrl: "https://meet.google.com/abc-defg-hij",
    durationSec: 1800,
    devScript: "/repo/src/meet-bot/joiner.ts",
    prodScript: "/repo/dist/meet-bot/joiner.js",
    stayMode: "stay-until-end",
  };

  it("builds the dev (tsx) argv: npx tsx <devScript> <url> --duration <n> --stay-mode <mode>", () => {
    const argv = buildJoinerArgs({ ...base, useTsx: true });
    expect(argv).toEqual([
      "npx",
      "tsx",
      "/repo/src/meet-bot/joiner.ts",
      "https://meet.google.com/abc-defg-hij",
      "--duration",
      "1800",
      "--stay-mode",
      "stay-until-end",
    ]);
  });

  it("builds the prod (node) argv: node <prodScript> <url> --duration <n> --stay-mode <mode>", () => {
    const argv = buildJoinerArgs({ ...base, useTsx: false });
    expect(argv).toEqual([
      "node",
      "/repo/dist/meet-bot/joiner.js",
      "https://meet.google.com/abc-defg-hij",
      "--duration",
      "1800",
      "--stay-mode",
      "stay-until-end",
    ]);
  });

  it("stringifies the duration value", () => {
    const argv = buildJoinerArgs({ ...base, durationSec: 60, useTsx: false });
    const durIdx = argv.indexOf("--duration");
    expect(durIdx).toBeGreaterThan(-1);
    expect(argv[durIdx + 1]).toBe("60");
    expect(typeof argv[durIdx + 1]).toBe("string");
  });

  it("always includes the --stay-mode flag with the given mode", () => {
    const argv = buildJoinerArgs({ ...base, stayMode: "stay-until-end", useTsx: true });
    const modeIdx = argv.indexOf("--stay-mode");
    expect(modeIdx).toBeGreaterThan(-1);
    expect(argv[modeIdx + 1]).toBe("stay-until-end");
  });

  it("places the meet URL before the flags", () => {
    const argv = buildJoinerArgs({ ...base, useTsx: false });
    const urlIdx = argv.indexOf(base.meetUrl);
    const durIdx = argv.indexOf("--duration");
    expect(urlIdx).toBeGreaterThan(-1);
    expect(urlIdx).toBeLessThan(durIdx);
  });
});
