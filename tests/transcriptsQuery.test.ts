import { describe, it, expect } from "vitest";
import {
  buildSearchQuery,
  buildRecentQuery,
  escapeDriveQueryValue,
  extractDocText,
  truncateDocText,
  mapSearchFiles,
  mapRecentFiles,
  type GoogleDocBody,
} from "../src/mcp/transcriptsQuery.js";

describe("buildSearchQuery", () => {
  // 2026-06-15T00:00:00Z is unambiguous; afterStr is now-days_back in UTC ISO.
  const now = new Date("2026-06-15T00:00:00.000Z");

  it("restricts to non-trashed Google Docs modified after now-days_back", () => {
    const q = buildSearchQuery(14, now);
    expect(q).toContain("mimeType='application/vnd.google-apps.document'");
    expect(q).toContain("trashed = false");
    expect(q).toContain("modifiedTime > '2026-06-01T00:00:00.000Z'");
  });

  it("falls back to name contains 'transcript' when no query is given", () => {
    const q = buildSearchQuery(14, now);
    expect(q).toContain("name contains 'transcript'");
    expect(q).not.toContain("fullText contains");
  });

  it("ORs name + fullText contains-match when a query is given", () => {
    const q = buildSearchQuery(7, now, "leadership standup");
    expect(q).toContain(
      "(name contains 'leadership standup' or fullText contains 'leadership standup')"
    );
    // The fallback transcript-name clause is NOT appended when a query exists.
    expect(q).not.toContain("name contains 'transcript'");
  });

  it("backslash-escapes single quotes in the query to avoid breaking the q string", () => {
    const q = buildSearchQuery(7, now, "O'Brien sync");
    expect(q).toContain("name contains 'O\\'Brien sync'");
    expect(q).toContain("fullText contains 'O\\'Brien sync'");
  });

  it("escapes backslashes in the query so the value cannot break the q string", () => {
    // Raw input: a\b  -> the backslash must be doubled per the q grammar.
    const q = buildSearchQuery(7, now, "a\\b");
    expect(q).toContain("name contains 'a\\\\b'");
    expect(q).toContain("fullText contains 'a\\\\b'");
  });

  it("escapes both backslash and quote (backslash first) for a combined input", () => {
    // Raw input: a\'b  -> backslash doubled then quote escaped => a\\\'b
    const q = buildSearchQuery(7, now, "a\\'b");
    expect(q).toContain("name contains 'a\\\\\\'b'");
    expect(q).toContain("fullText contains 'a\\\\\\'b'");
  });

  it("computes the date boundary deterministically from injected now", () => {
    const q = buildSearchQuery(1, new Date("2026-01-01T12:00:00.000Z"));
    expect(q).toContain("modifiedTime > '2025-12-31T12:00:00.000Z'");
  });
});

describe("buildRecentQuery", () => {
  it("always filters to transcript-named, non-trashed docs after now-days", () => {
    const q = buildRecentQuery(7, new Date("2026-06-15T00:00:00.000Z"));
    expect(q).toContain("mimeType='application/vnd.google-apps.document'");
    expect(q).toContain("trashed = false");
    expect(q).toContain("name contains 'transcript'");
    expect(q).toContain("modifiedTime > '2026-06-08T00:00:00.000Z'");
  });
});

describe("escapeDriveQueryValue", () => {
  it("escapes a single quote to \\'", () => {
    expect(escapeDriveQueryValue("O'Brien")).toBe("O\\'Brien");
  });

  it("escapes a backslash to \\\\", () => {
    expect(escapeDriveQueryValue("a\\b")).toBe("a\\\\b");
  });

  it("escapes backslash FIRST then quote for a combined input", () => {
    // Raw: a\'b -> backslash doubled (a\\) then quote escaped (\') => a\\\'b
    expect(escapeDriveQueryValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it("leaves a value with no special characters unchanged", () => {
    expect(escapeDriveQueryValue("leadership standup")).toBe("leadership standup");
  });
});

describe("extractDocText", () => {
  it("concatenates every paragraph textRun content in order", () => {
    const doc: GoogleDocBody = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: "Alice: " } },
                { textRun: { content: "Hello.\n" } },
              ],
            },
          },
          {
            paragraph: {
              elements: [{ textRun: { content: "Bob: Hi.\n" } }],
            },
          },
        ],
      },
    };
    expect(extractDocText(doc)).toBe("Alice: Hello.\nBob: Hi.\n");
  });

  it("skips non-paragraph structural elements (e.g. tables / section breaks)", () => {
    const doc: GoogleDocBody = {
      body: {
        content: [
          { paragraph: { elements: [{ textRun: { content: "kept\n" } }] } },
          { sectionBreak: {} } as any,
          { table: {} } as any,
          { paragraph: { elements: [{ textRun: { content: "also kept\n" } }] } },
        ],
      },
    };
    expect(extractDocText(doc)).toBe("kept\nalso kept\n");
  });

  it("ignores elements without textRun content", () => {
    const doc: GoogleDocBody = {
      body: {
        content: [
          {
            paragraph: {
              elements: [
                { textRun: { content: null } },
                {} as any,
                { textRun: { content: "real" } },
              ],
            },
          },
        ],
      },
    };
    expect(extractDocText(doc)).toBe("real");
  });

  it("returns '' for an empty / missing body", () => {
    expect(extractDocText({})).toBe("");
    expect(extractDocText({ body: { content: [] } })).toBe("");
  });
});

describe("truncateDocText", () => {
  it("returns full text untruncated when under max_length", () => {
    const out = truncateDocText("short", 5000);
    expect(out).toEqual({ characterCount: 5, truncated: false, content: "short" });
  });

  it("truncates to max_length and reports the FULL character count", () => {
    const full = "a".repeat(6000);
    const out = truncateDocText(full, 5000);
    expect(out.truncated).toBe(true);
    expect(out.characterCount).toBe(6000);
    expect(out.content).toHaveLength(5000);
  });

  it("exact-length text is not flagged truncated (strictly greater check)", () => {
    const full = "a".repeat(100);
    const out = truncateDocText(full, 100);
    expect(out.truncated).toBe(false);
    expect(out.content).toBe(full);
  });
});

describe("mapSearchFiles", () => {
  it("maps files and pulls the first owner's email", () => {
    const out = mapSearchFiles([
      {
        id: "f1",
        name: "Meeting transcript - Standup",
        createdTime: "2026-06-01T10:00:00Z",
        modifiedTime: "2026-06-01T11:00:00Z",
        webViewLink: "https://drive/f1",
        owners: [{ emailAddress: "owner@x.co" }, { emailAddress: "second@x.co" }],
      },
    ]);
    expect(out).toEqual([
      {
        id: "f1",
        name: "Meeting transcript - Standup",
        createdTime: "2026-06-01T10:00:00Z",
        modifiedTime: "2026-06-01T11:00:00Z",
        webViewLink: "https://drive/f1",
        owner: "owner@x.co",
      },
    ]);
  });

  it("leaves owner undefined when there are no owners", () => {
    const out = mapSearchFiles([{ id: "f2", name: "x" }]);
    expect(out[0].owner).toBeUndefined();
  });

  it("returns [] for an empty list", () => {
    expect(mapSearchFiles([])).toEqual([]);
  });
});

describe("mapRecentFiles", () => {
  it("maps files WITHOUT an owner field", () => {
    const out = mapRecentFiles([
      {
        id: "f1",
        name: "transcript x",
        createdTime: "c",
        modifiedTime: "m",
        webViewLink: "l",
        owners: [{ emailAddress: "owner@x.co" }],
      },
    ]);
    expect(out[0]).not.toHaveProperty("owner");
    expect(out[0]).toEqual({
      id: "f1",
      name: "transcript x",
      createdTime: "c",
      modifiedTime: "m",
      webViewLink: "l",
    });
  });
});
