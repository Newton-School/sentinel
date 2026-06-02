import { describe, it, expect } from "vitest";
import {
  resourceId,
  mapConferences,
  mapTranscripts,
  shapeTranscriptEntry,
} from "../src/mcp/meetShape.js";

describe("resourceId", () => {
  it("returns the trailing path segment", () => {
    expect(resourceId("conferenceRecords/abc/participants/123")).toBe("123");
    expect(resourceId("conferenceRecords/abc")).toBe("abc");
  });

  it("returns undefined for undefined/null", () => {
    expect(resourceId(undefined)).toBeUndefined();
    expect(resourceId(null)).toBeUndefined();
  });

  it("returns the whole string when there's no slash", () => {
    expect(resourceId("plain")).toBe("plain");
  });
});

describe("mapConferences", () => {
  it("maps name→id/resourceName and passes through times + space", () => {
    const out = mapConferences([
      {
        name: "conferenceRecords/conf-1",
        startTime: "2026-06-01T10:00:00Z",
        endTime: "2026-06-01T11:00:00Z",
        space: "spaces/s1",
      },
    ]);
    expect(out).toEqual([
      {
        id: "conf-1",
        resourceName: "conferenceRecords/conf-1",
        startTime: "2026-06-01T10:00:00Z",
        endTime: "2026-06-01T11:00:00Z",
        spaceName: "spaces/s1",
      },
    ]);
  });

  it("returns [] for an empty list", () => {
    expect(mapConferences([])).toEqual([]);
  });

  it("leaves optional times/space undefined when absent", () => {
    const out = mapConferences([{ name: "conferenceRecords/c2" }]);
    expect(out[0]).toEqual({
      id: "c2",
      resourceName: "conferenceRecords/c2",
      startTime: undefined,
      endTime: undefined,
      spaceName: undefined,
    });
  });
});

describe("mapTranscripts", () => {
  it("flattens docsDestination into driveDocumentId/Url", () => {
    const out = mapTranscripts([
      {
        name: "conferenceRecords/c1/transcripts/t1",
        state: "ENDED",
        startTime: "2026-06-01T10:00:00Z",
        endTime: "2026-06-01T11:00:00Z",
        docsDestination: { document: "doc-1", exportUri: "https://docs/doc-1" },
      },
    ]);
    expect(out).toEqual([
      {
        id: "t1",
        resourceName: "conferenceRecords/c1/transcripts/t1",
        state: "ENDED",
        startTime: "2026-06-01T10:00:00Z",
        endTime: "2026-06-01T11:00:00Z",
        driveDocumentId: "doc-1",
        driveDocumentUrl: "https://docs/doc-1",
      },
    ]);
  });

  it("leaves drive fields undefined when docsDestination is absent", () => {
    const out = mapTranscripts([
      { name: "conferenceRecords/c1/transcripts/t2", state: "STARTED" },
    ]);
    expect(out[0].driveDocumentId).toBeUndefined();
    expect(out[0].driveDocumentUrl).toBeUndefined();
  });

  it("returns [] for an empty list", () => {
    expect(mapTranscripts([])).toEqual([]);
  });
});

describe("shapeTranscriptEntry", () => {
  it("uses the resolved speaker name when the entry has a participant", () => {
    const out = shapeTranscriptEntry(
      {
        participant: "conferenceRecords/c/participants/p1",
        text: "Hello team",
        languageCode: "en-US",
        startTime: "0s",
        endTime: "2s",
      },
      "Alice Anderson"
    );
    expect(out).toEqual({
      speaker: "Alice Anderson",
      participant: "conferenceRecords/c/participants/p1",
      speakerId: "conferenceRecords/c/participants/p1",
      text: "Hello team",
      startTime: "0s",
      endTime: "2s",
      language: "en-US",
    });
  });

  it("sets speaker undefined when there's no participant (even if a name is passed)", () => {
    const out = shapeTranscriptEntry(
      { text: "anonymous caption" },
      "Should Be Ignored"
    );
    expect(out.speaker).toBeUndefined();
    expect(out.participant).toBeUndefined();
    expect(out.speakerId).toBeUndefined();
    expect(out.text).toBe("anonymous caption");
  });

  it("retains the raw resource name under both participant and speakerId", () => {
    const resource = "conferenceRecords/c/participants/p2";
    const out = shapeTranscriptEntry({ participant: resource, text: "x" }, "Bob");
    expect(out.participant).toBe(resource);
    expect(out.speakerId).toBe(resource);
  });
});
