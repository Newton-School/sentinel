import { describe, it, expect } from "vitest";
import { extractPlainTextBody, type GmailPart } from "../src/mcp/gmailBody.js";

const b64url = (text: string) => Buffer.from(text).toString("base64url");

describe("extractPlainTextBody", () => {
  it("returns the text for a top-level text/plain part", () => {
    const payload: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url("Hello world") } },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("Hello world");
  });

  it("finds text/plain nested one level inside multipart/alternative", () => {
    // This is the core bug: the OLD inline logic (.find on top-level parts only)
    // would miss this because the outer node is multipart/alternative, not text/plain.
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("Nested one level") } },
            { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
          ],
        },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("Nested one level");
  });

  it("finds text/plain nested two levels and ignores html + attachment", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain", body: { data: b64url("The real body") } },
            { mimeType: "text/html", body: { data: b64url("<p>should not win</p>") } },
          ],
        },
        {
          mimeType: "application/pdf",
          body: { data: b64url("PDFBYTES") },
        },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("The real body");
  });

  it("returns empty string when only text/html is present (no html fallback)", () => {
    const payload: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>only html</p>") } },
      ],
    };
    expect(extractPlainTextBody(payload)).toBe("");
  });

  it("handles a single-part text/plain message with no parts", () => {
    const payload: GmailPart = {
      mimeType: "text/plain",
      body: { data: b64url("Single part message") },
    };
    expect(extractPlainTextBody(payload)).toBe("Single part message");
  });

  it("returns empty string for undefined payload", () => {
    expect(extractPlainTextBody(undefined)).toBe("");
  });

  it("returns empty string for null payload", () => {
    expect(extractPlainTextBody(null)).toBe("");
  });

  it("decodes Gmail base64url correctly (chars that differ from base64)", () => {
    // This string forces '+' and '/' in standard base64, which become '-' and '_'
    // in base64url. Decoding base64url-encoded data as plain "base64" would corrupt it.
    const tricky = "Café ☕ <subject> a?b>c";
    const data = Buffer.from(tricky).toString("base64url");
    expect(data).not.toContain("+");
    expect(data).not.toContain("/");
    const payload: GmailPart = {
      mimeType: "text/plain",
      body: { data },
    };
    expect(extractPlainTextBody(payload)).toBe(tricky);
  });
});
