import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs } from "../src/meet-bot/joiner.js";

const VALID_URL = "https://meet.google.com/abc-defg-hij";

describe("joiner parseArgs", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // process.exit must not actually exit the test runner. Throw instead so we
    // can assert it was called and stop execution at that point.
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("parses a valid URL with defaults", () => {
    const opts = parseArgs([VALID_URL]);
    expect(opts.meetUrl).toBe(VALID_URL);
    expect(opts.maxDurationSec).toBe(2 * 60 * 60); // DEFAULT_DURATION_SEC
    expect(opts.headed).toBe(false);
    expect(opts.stayMode).toBe("leave-after-join"); // parseStayMode default
  });

  it("parses --duration", () => {
    const opts = parseArgs([VALID_URL, "--duration", "1800"]);
    expect(opts.maxDurationSec).toBe(1800);
  });

  it("parses --headed", () => {
    const opts = parseArgs([VALID_URL, "--headed"]);
    expect(opts.headed).toBe(true);
  });

  it("parses --stay-mode", () => {
    const opts = parseArgs([VALID_URL, "--stay-mode", "stay-until-end"]);
    expect(opts.stayMode).toBe("stay-until-end");
  });

  it("parses all flags together", () => {
    const opts = parseArgs([
      VALID_URL,
      "--duration",
      "600",
      "--headed",
      "--stay-mode",
      "hybrid",
    ]);
    expect(opts).toEqual({
      meetUrl: VALID_URL,
      maxDurationSec: 600,
      headed: true,
      stayMode: "hybrid",
    });
  });

  it("calls process.exit(1) when the URL is missing", () => {
    expect(() => parseArgs([])).toThrow("process.exit(1)");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("calls process.exit(1) when the URL is invalid", () => {
    expect(() => parseArgs(["https://example.com/not-a-meet"])).toThrow(
      "process.exit(1)"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("throws on an invalid --stay-mode value", () => {
    // parseStayMode throws (not process.exit) for unknown modes.
    expect(() => parseArgs([VALID_URL, "--stay-mode", "bogus"])).toThrow();
  });
});
