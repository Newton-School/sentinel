import { describe, it, expect } from "vitest";
import { participantDisplayName } from "../src/mcp/participantName.js";

describe("participantDisplayName", () => {
  it("returns signedinUser.displayName when present", () => {
    expect(
      participantDisplayName({
        name: "conferenceRecords/abc/participants/123",
        signedinUser: { displayName: "Alice Anderson" },
      })
    ).toBe("Alice Anderson");
  });

  it("returns anonymousUser.displayName when only that is present", () => {
    expect(
      participantDisplayName({
        name: "conferenceRecords/abc/participants/123",
        anonymousUser: { displayName: "Anonymous Guest" },
      })
    ).toBe("Anonymous Guest");
  });

  it("returns phoneUser.displayName when only that is present", () => {
    expect(
      participantDisplayName({
        name: "conferenceRecords/abc/participants/123",
        phoneUser: { displayName: "+1 555-0100" },
      })
    ).toBe("+1 555-0100");
  });

  it("prefers signedinUser over anonymousUser and phoneUser (precedence)", () => {
    expect(
      participantDisplayName({
        name: "conferenceRecords/abc/participants/123",
        signedinUser: { displayName: "Signed In" },
        anonymousUser: { displayName: "Anon" },
        phoneUser: { displayName: "Phone" },
      })
    ).toBe("Signed In");
  });

  it("prefers anonymousUser over phoneUser when signedinUser absent", () => {
    expect(
      participantDisplayName({
        anonymousUser: { displayName: "Anon" },
        phoneUser: { displayName: "Phone" },
      })
    ).toBe("Anon");
  });

  it("returns '' when no display name is present", () => {
    expect(participantDisplayName({ name: "conferenceRecords/abc/participants/123" })).toBe("");
  });

  it("returns '' for an empty object", () => {
    expect(participantDisplayName({})).toBe("");
  });

  it("returns '' for undefined", () => {
    expect(participantDisplayName(undefined)).toBe("");
  });

  it("returns '' for null", () => {
    expect(participantDisplayName(null)).toBe("");
  });

  it("ignores a present user object whose displayName is null/empty and falls through", () => {
    expect(
      participantDisplayName({
        signedinUser: { displayName: null },
        anonymousUser: { displayName: "Anon Fallback" },
      })
    ).toBe("Anon Fallback");
  });

  it("returns '' when all displayNames are empty strings", () => {
    expect(
      participantDisplayName({
        signedinUser: { displayName: "" },
        anonymousUser: { displayName: "" },
        phoneUser: { displayName: "" },
      })
    ).toBe("");
  });
});
