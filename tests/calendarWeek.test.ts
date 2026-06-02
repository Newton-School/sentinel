import { describe, it, expect } from "vitest";
import {
  weekWindow,
  startBoundary,
  endBoundary,
  mapEvent,
  mapSearchEvent,
  type CalendarEvent,
} from "../src/mcp/calendarWeek.js";

describe("weekWindow (timezone-aware)", () => {
  // The Monday→Friday window is computed in the calendar's IANA timezone, then
  // serialized as the corresponding UTC ISO instants. These expectations are
  // computed by hand and are INDEPENDENT of the host's local timezone.
  //
  // IST (Asia/Kolkata) = UTC+5:30, no DST.
  // America/New_York in June = EDT = UTC-4 (DST active).

  it("computes the Mon→Fri window in Asia/Kolkata (IST = UTC+5:30) for a mid-week instant", () => {
    // 2026-06-03T12:00:00Z is Wednesday 17:30 IST → week is Mon Jun 1 .. Fri Jun 5 (IST).
    const now = new Date("2026-06-03T12:00:00Z");
    const { timeMin, timeMax } = weekWindow(now, "Asia/Kolkata");
    // Mon 2026-06-01 00:00:00.000 IST = 2026-05-31T18:30:00.000Z
    expect(timeMin).toBe("2026-05-31T18:30:00.000Z");
    // Fri 2026-06-05 23:59:59.999 IST = 2026-06-05T18:29:59.999Z
    expect(timeMax).toBe("2026-06-05T18:29:59.999Z");
  });

  it("computes a DIFFERENT, correct window for America/New_York (EDT = UTC-4) for the same instant", () => {
    // 2026-06-03T12:00:00Z is Wednesday 08:00 EDT → week is Mon Jun 1 .. Fri Jun 5 (NY).
    const now = new Date("2026-06-03T12:00:00Z");
    const { timeMin, timeMax } = weekWindow(now, "America/New_York");
    // Mon 2026-06-01 00:00:00.000 EDT = 2026-06-01T04:00:00.000Z
    expect(timeMin).toBe("2026-06-01T04:00:00.000Z");
    // Fri 2026-06-05 23:59:59.999 EDT = 2026-06-06T03:59:59.999Z
    expect(timeMax).toBe("2026-06-06T03:59:59.999Z");
  });

  it("rolls Sunday back to the PREVIOUS Monday in the target timezone", () => {
    // 2026-06-07T12:00:00Z is Sunday 17:30 IST → Monday rolls back to Jun 1, Friday Jun 5.
    const now = new Date("2026-06-07T12:00:00Z");
    const { timeMin, timeMax } = weekWindow(now, "Asia/Kolkata");
    expect(timeMin).toBe("2026-05-31T18:30:00.000Z");
    expect(timeMax).toBe("2026-06-05T18:29:59.999Z");
  });

  it("on Monday itself, timeMin is that same Monday at 00:00 in the target timezone", () => {
    // 2026-06-01T12:00:00Z is Monday 17:30 IST.
    const now = new Date("2026-06-01T12:00:00Z");
    const { timeMin } = weekWindow(now, "Asia/Kolkata");
    expect(timeMin).toBe("2026-05-31T18:30:00.000Z");
  });

  it("the window spans Monday→Friday inclusive (4 days + nearly a full day apart)", () => {
    const now = new Date("2026-06-03T12:00:00Z");
    const { timeMin, timeMax } = weekWindow(now, "Asia/Kolkata");
    const spanMs = new Date(timeMax).getTime() - new Date(timeMin).getTime();
    const fourDays = 4 * 24 * 60 * 60 * 1000;
    expect(spanMs).toBeGreaterThan(fourDays);
    expect(spanMs).toBeLessThan(5 * 24 * 60 * 60 * 1000);
  });

  it("a UTC-day that is a different weekday in the target tz uses the tz weekday", () => {
    // 2026-06-07T20:00:00Z is Sunday in UTC but 01:30 Monday Jun 8 in IST.
    // In IST the week is Mon Jun 8 .. Fri Jun 12.
    const now = new Date("2026-06-07T20:00:00Z");
    const { timeMin, timeMax } = weekWindow(now, "Asia/Kolkata");
    // Mon 2026-06-08 00:00 IST = 2026-06-07T18:30:00.000Z
    expect(timeMin).toBe("2026-06-07T18:30:00.000Z");
    // Fri 2026-06-12 23:59:59.999 IST = 2026-06-12T18:29:59.999Z
    expect(timeMax).toBe("2026-06-12T18:29:59.999Z");
  });
});

describe("startBoundary / endBoundary (timezone-aware)", () => {
  it("startBoundary is start-of-day in the target timezone", () => {
    // Apr 7 00:00:00.000 IST = 2026-04-06T18:30:00.000Z
    expect(startBoundary("2026-04-07", "Asia/Kolkata")).toBe("2026-04-06T18:30:00.000Z");
  });

  it("endBoundary is end-of-day (23:59:59.999) in the target timezone", () => {
    // Apr 11 23:59:59.999 IST = 2026-04-11T18:29:59.999Z
    expect(endBoundary("2026-04-11", "Asia/Kolkata")).toBe("2026-04-11T18:29:59.999Z");
  });

  it("startBoundary respects a DST zone (America/New_York, EDT = UTC-4)", () => {
    // Apr 7 00:00:00.000 EDT = 2026-04-07T04:00:00.000Z
    expect(startBoundary("2026-04-07", "America/New_York")).toBe("2026-04-07T04:00:00.000Z");
  });

  it("endBoundary respects a DST zone (America/New_York, EDT = UTC-4)", () => {
    // Apr 11 23:59:59.999 EDT = 2026-04-12T03:59:59.999Z
    expect(endBoundary("2026-04-11", "America/New_York")).toBe("2026-04-12T03:59:59.999Z");
  });
});

describe("mapEvent", () => {
  it("maps a full timed event including attendees and organizer", () => {
    const event: CalendarEvent = {
      id: "e1",
      summary: "Leadership standup",
      start: { dateTime: "2026-06-01T10:00:00Z" },
      end: { dateTime: "2026-06-01T10:30:00Z" },
      description: "weekly sync",
      location: "Room A",
      hangoutLink: "https://meet/x",
      attendees: [
        { email: "a@x.co", displayName: "Alice", responseStatus: "accepted" },
        { email: "b@x.co", displayName: "Bob", responseStatus: "needsAction" },
      ],
      organizer: { email: "org@x.co" },
    };
    expect(mapEvent(event)).toEqual({
      id: "e1",
      summary: "Leadership standup",
      start: "2026-06-01T10:00:00Z",
      end: "2026-06-01T10:30:00Z",
      description: "weekly sync",
      location: "Room A",
      meetLink: "https://meet/x",
      attendees: [
        { email: "a@x.co", displayName: "Alice", responseStatus: "accepted" },
        { email: "b@x.co", displayName: "Bob", responseStatus: "needsAction" },
      ],
      organizer: "org@x.co",
    });
  });

  it("prefers dateTime over date, defaults missing title, gives [] attendees", () => {
    const event: CalendarEvent = {
      id: "e2",
      start: { date: "2026-06-01" },
      end: { date: "2026-06-02" },
    };
    const out = mapEvent(event);
    expect(out.summary).toBe("(no title)");
    expect(out.start).toBe("2026-06-01");
    expect(out.end).toBe("2026-06-02");
    expect(out.attendees).toEqual([]);
    expect(out.organizer).toBeUndefined();
  });

  it("truncates description to 300 characters", () => {
    const out = mapEvent({ description: "z".repeat(500) });
    expect(out.description).toHaveLength(300);
  });
});

describe("mapSearchEvent", () => {
  it("returns attendeeCount instead of the attendee list", () => {
    const out = mapSearchEvent({
      id: "e1",
      summary: "Review",
      start: { dateTime: "2026-06-01T10:00:00Z" },
      end: { dateTime: "2026-06-01T11:00:00Z" },
      hangoutLink: "https://meet/y",
      attendees: [{ email: "a" }, { email: "b" }, { email: "c" }],
    });
    expect(out).toEqual({
      id: "e1",
      summary: "Review",
      start: "2026-06-01T10:00:00Z",
      end: "2026-06-01T11:00:00Z",
      meetLink: "https://meet/y",
      attendeeCount: 3,
    });
  });

  it("attendeeCount is 0 when there are no attendees; default title applies", () => {
    const out = mapSearchEvent({ id: "e2" });
    expect(out.attendeeCount).toBe(0);
    expect(out.summary).toBe("(no title)");
  });
});
