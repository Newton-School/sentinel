import { describe, it, expect, vi } from "vitest";
import { findMissingEnv, assertEnv } from "../src/mcp/requireEnv.js";

describe("findMissingEnv", () => {
  it("returns names that are absent from env", () => {
    expect(findMissingEnv(["A", "B"], { A: "x" })).toEqual(["B"]);
  });

  it("returns empty array when all present", () => {
    expect(findMissingEnv(["A", "B"], { A: "x", B: "y" })).toEqual([]);
  });

  it("treats empty string as missing", () => {
    expect(findMissingEnv(["A", "B"], { A: "x", B: "" })).toEqual(["B"]);
  });

  it("treats whitespace-only as missing", () => {
    expect(findMissingEnv(["A"], { A: "   " })).toEqual(["A"]);
  });

  it("treats undefined as missing", () => {
    expect(findMissingEnv(["A"], { A: undefined })).toEqual(["A"]);
  });

  it("respects the passed env (does not read process.env)", () => {
    const prev = process.env.SOME_UNLIKELY_VAR_XYZ;
    process.env.SOME_UNLIKELY_VAR_XYZ = "set-in-process";
    try {
      // Passing an explicit env that lacks the var → it's still missing.
      expect(findMissingEnv(["SOME_UNLIKELY_VAR_XYZ"], {})).toEqual([
        "SOME_UNLIKELY_VAR_XYZ",
      ]);
    } finally {
      if (prev === undefined) delete process.env.SOME_UNLIKELY_VAR_XYZ;
      else process.env.SOME_UNLIKELY_VAR_XYZ = prev;
    }
  });

  it("preserves the order of the requested names", () => {
    expect(findMissingEnv(["A", "B", "C"], { B: "y" })).toEqual(["A", "C"]);
  });

  it("returns empty array for empty name list", () => {
    expect(findMissingEnv([], { A: "x" })).toEqual([]);
  });
});

describe("assertEnv", () => {
  it("calls error and exit(1) when vars are missing", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const error = vi.fn();

    assertEnv(["A", "B"], { A: "x" }, { exit, error });

    expect(error).toHaveBeenCalledTimes(1);
    const msg = (error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("B");
    expect(msg).toContain("missing required env");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("lists all missing vars in the message", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const error = vi.fn();

    assertEnv(["A", "B", "C"], {}, { exit, error });

    const msg = (error as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toContain("A");
    expect(msg).toContain("B");
    expect(msg).toContain("C");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not call error or exit when all vars present", () => {
    const exit = vi.fn() as unknown as (code: number) => never;
    const error = vi.fn();

    assertEnv(["A", "B"], { A: "x", B: "y" }, { exit, error });

    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
