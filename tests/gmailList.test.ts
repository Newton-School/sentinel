import { describe, it, expect } from "vitest";
import {
  getHeader,
  buildRecentQuery,
  shapeSearchResult,
  shapeListResult,
  type GmailMessageDetail,
} from "../src/mcp/gmailList.js";

describe("getHeader", () => {
  const headers = [
    { name: "From", value: "ceo@newtonschool.co" },
    { name: "Subject", value: "Admissions update" },
  ];

  it("is case-insensitive on the header name", () => {
    expect(getHeader(headers, "from")).toBe("ceo@newtonschool.co");
    expect(getHeader(headers, "SUBJECT")).toBe("Admissions update");
  });

  it("returns '' when the header is absent", () => {
    expect(getHeader(headers, "Cc")).toBe("");
  });

  it("returns '' for undefined/null header arrays", () => {
    expect(getHeader(undefined, "From")).toBe("");
    expect(getHeader(null, "From")).toBe("");
  });

  it("returns the first match when duplicated", () => {
    expect(
      getHeader(
        [
          { name: "Received", value: "first" },
          { name: "Received", value: "second" },
        ],
        "Received"
      )
    ).toBe("first");
  });
});

describe("buildRecentQuery", () => {
  it("builds after:YYYY/MM/DD with zero-padded month/day", () => {
    // now = 2026-06-02; 7 days back = 2026-05-26
    const now = new Date(2026, 5, 2, 10, 30); // local June 2 2026
    expect(buildRecentQuery(7, now)).toBe("after:2026/05/26");
  });

  it("appends label:<label> when provided", () => {
    const now = new Date(2026, 5, 2, 10, 30);
    expect(buildRecentQuery(7, now, "IMPORTANT")).toBe(
      "after:2026/05/26 label:IMPORTANT"
    );
  });

  it("zero-pads single-digit month and day", () => {
    // now = 2026-01-10 local; 3 days back = 2026-01-07
    const now = new Date(2026, 0, 10, 12, 0);
    expect(buildRecentQuery(3, now)).toBe("after:2026/01/07");
  });

  it("rolls back across a month boundary", () => {
    // now = 2026-03-02; 5 days back = 2026-02-25
    const now = new Date(2026, 2, 2, 9, 0);
    expect(buildRecentQuery(5, now)).toBe("after:2026/02/25");
  });

  it("days=0 uses today's date", () => {
    const now = new Date(2026, 5, 2, 9, 0);
    expect(buildRecentQuery(0, now)).toBe("after:2026/06/02");
  });
});

describe("shapeSearchResult", () => {
  const detail: GmailMessageDetail = {
    threadId: "t1",
    snippet: "Quick update on admissions",
    labelIds: ["INBOX", "IMPORTANT"],
    payload: {
      headers: [
        { name: "From", value: "a@x.co" },
        { name: "To", value: "b@x.co" },
        { name: "Cc", value: "c@x.co" },
        { name: "Subject", value: "Admissions" },
        { name: "Date", value: "Mon, 01 Jun 2026 10:00:00 +0000" },
      ],
    },
  };

  it("extracts all headers + snippet + labels + threadId + id", () => {
    expect(shapeSearchResult("m1", detail)).toEqual({
      id: "m1",
      threadId: "t1",
      snippet: "Quick update on admissions",
      from: "a@x.co",
      to: "b@x.co",
      cc: "c@x.co",
      subject: "Admissions",
      date: "Mon, 01 Jun 2026 10:00:00 +0000",
      labelIds: ["INBOX", "IMPORTANT"],
    });
  });

  it("defaults missing snippet to '' and missing headers to ''", () => {
    const out = shapeSearchResult("m2", { threadId: "t2", payload: { headers: [] } });
    expect(out.snippet).toBe("");
    expect(out.from).toBe("");
    expect(out.to).toBe("");
    expect(out.cc).toBe("");
    expect(out.subject).toBe("");
    expect(out.date).toBe("");
  });

  it("tolerates a fully empty detail (no payload)", () => {
    const out = shapeSearchResult(undefined, {});
    expect(out.from).toBe("");
    expect(out.snippet).toBe("");
    expect(out.labelIds).toBeUndefined();
  });
});

describe("shapeListResult", () => {
  it("includes From/Subject/Date + snippet but NOT to/cc/labels", () => {
    const out = shapeListResult("m1", {
      threadId: "t1",
      snippet: "hi",
      labelIds: ["INBOX"],
      payload: {
        headers: [
          { name: "From", value: "a@x.co" },
          { name: "To", value: "b@x.co" },
          { name: "Subject", value: "S" },
          { name: "Date", value: "D" },
        ],
      },
    });
    expect(out).toEqual({
      id: "m1",
      threadId: "t1",
      snippet: "hi",
      from: "a@x.co",
      subject: "S",
      date: "D",
    });
    expect(out).not.toHaveProperty("to");
    expect(out).not.toHaveProperty("cc");
    expect(out).not.toHaveProperty("labelIds");
  });
});
