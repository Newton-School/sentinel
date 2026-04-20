import { describe, it, expect } from "vitest";
import { extractMeetUrl, isValidMeetUrl, extractMeetingCode } from "../src/meet-bot/meetUrl.js";

describe("extractMeetUrl", () => {
  it("returns the URL directly when input is already a Meet URL", () => {
    expect(extractMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
  });

  it("extracts Meet URL from calendar event description text", () => {
    const description = `Hey team, join us for the review.
Google Meet joining info
Video call link: https://meet.google.com/xyz-abcd-efg
Or dial: +1 555-1234`;
    expect(extractMeetUrl(description)).toBe("https://meet.google.com/xyz-abcd-efg");
  });

  it("returns null when no Meet URL is found", () => {
    expect(extractMeetUrl("just some text, no meeting link")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractMeetUrl("")).toBeNull();
  });

  it("ignores tel.meet URLs (phone dial links)", () => {
    const text = "Join via https://tel.meet/abc-defg-hij?pin=12345";
    expect(extractMeetUrl(text)).toBeNull();
  });

  it("handles http:// prefix", () => {
    expect(extractMeetUrl("http://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
  });

  it("strips trailing punctuation", () => {
    expect(extractMeetUrl("Join here: https://meet.google.com/abc-defg-hij.")).toBe(
      "https://meet.google.com/abc-defg-hij"
    );
  });
});

describe("isValidMeetUrl", () => {
  it("accepts standard meet.google.com URLs", () => {
    expect(isValidMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(true);
  });

  it("rejects non-meet URLs", () => {
    expect(isValidMeetUrl("https://example.com/abc-defg-hij")).toBe(false);
    expect(isValidMeetUrl("https://google.com/abc-defg-hij")).toBe(false);
  });

  it("rejects malformed codes", () => {
    expect(isValidMeetUrl("https://meet.google.com/abc")).toBe(false);
    expect(isValidMeetUrl("https://meet.google.com/")).toBe(false);
  });

  it("rejects empty and garbage input", () => {
    expect(isValidMeetUrl("")).toBe(false);
    expect(isValidMeetUrl("not a url")).toBe(false);
  });
});

describe("extractMeetingCode", () => {
  it("extracts the meeting code from a Meet URL", () => {
    expect(extractMeetingCode("https://meet.google.com/abc-defg-hij")).toBe(
      "abc-defg-hij"
    );
  });

  it("returns null for invalid URLs", () => {
    expect(extractMeetingCode("https://example.com/xyz")).toBeNull();
  });

  it("strips query params and fragments", () => {
    expect(
      extractMeetingCode("https://meet.google.com/abc-defg-hij?pli=1#foo")
    ).toBe("abc-defg-hij");
  });
});
