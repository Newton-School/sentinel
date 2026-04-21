import { describe, it, expect } from "vitest";
import { decideAction, parseStayMode, type StayMode } from "../src/meet-bot/modeDispatch.js";

describe("parseStayMode", () => {
  it("defaults to leave-after-join", () => {
    expect(parseStayMode(undefined)).toBe("leave-after-join");
  });

  it("accepts valid modes", () => {
    expect(parseStayMode("leave-after-join")).toBe("leave-after-join");
    expect(parseStayMode("stay-until-end")).toBe("stay-until-end");
    expect(parseStayMode("hybrid")).toBe("hybrid");
  });

  it("throws on invalid mode", () => {
    expect(() => parseStayMode("invalid-mode")).toThrow();
  });
});

describe("decideAction", () => {
  const modes: StayMode[] = ["leave-after-join", "stay-until-end", "hybrid"];

  it.each([
    ["leave-after-join", true, "leave"],
    ["leave-after-join", false, "leave"],
    ["stay-until-end", true, "stay"],
    ["stay-until-end", false, "stay"],
    ["hybrid", true, "leave"],
    ["hybrid", false, "stay"],
  ] as Array<[StayMode, boolean, "leave" | "stay"]>)(
    "mode=%s transcriptionOn=%s → %s",
    (mode, transcriptionOn, expected) => {
      expect(decideAction(mode, transcriptionOn)).toBe(expected);
    }
  );

  it("covers every mode", () => {
    // Make sure no mode is accidentally unhandled
    for (const mode of modes) {
      expect(["leave", "stay"]).toContain(decideAction(mode, true));
      expect(["leave", "stay"]).toContain(decideAction(mode, false));
    }
  });
});
