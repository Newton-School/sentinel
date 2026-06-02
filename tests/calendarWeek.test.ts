import { describe, it, expect } from "vitest";
import {
  weekWindow,
  startBoundary,
  endBoundary,
  mapEvent,
  mapSearchEvent,
  type CalendarEvent,
} from "../src/mcp/calendarWeek.js";

describe("weekWindow", () => {
  // NOTE: these assertions characterize the CURRENT (local-time) behavior. The
  // window boundaries are computed on the host's LOCAL clock (getDay/setHours)
  // and then serialized via toISOString() (UTC). On a non-UTC host the emitted
  // ISO strings are skewed by the UTC offset — that latent bug is documented,
  // not fixed here. We assert against the same local-clock algorithm so the
  // tests are timezone-independent.

  function expectedMonday(now: Date): Date {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return monday;
  }
  function expectedFriday(now: Date): Date {
    const friday = new Date(now);
    friday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 4);
    friday.setHours(23, 59, 59, 999);
    return friday;
  }

  it("returns Monday 00:00 local → Friday 23:59:59.999 local for a mid-week day", () => {
    // Wednesday 2026-06-03 (local), arbitrary time of day.
    const now = new Date(2026, 5, 3, 14, 22, 7);
    const { timeMin, timeMax } = weekWindow(now);
    expect(timeMin).toBe(expectedMonday(now).toISOString());
    expect(timeMax).toBe(expectedFriday(now).toISOString());

    // Local-clock invariants (independent of host TZ):
    const min = new Date(timeMin);
    const max = new Date(timeMax);
    expect(min.getDay()).toBe(1); // Monday
    expect(max.getDay()).toBe(5); // Friday
    expect(min.getHours()).toBe(0);
    expect(min.getMinutes()).toBe(0);
    expect(max.getHours()).toBe(23);
    expect(max.getMinutes()).toBe(59);
  });

  it("rolls Sunday back to the PREVIOUS Monday (Sunday=0 maps to 6)", () => {
    // Sunday 2026-06-07 (local). Monday should be 2026-06-01, Friday 2026-06-05.
    const now = new Date(2026, 5, 7, 9, 0);
    const { timeMin, timeMax } = weekWindow(now);
    const min = new Date(timeMin);
    const max = new Date(timeMax);
    expect(min.getDay()).toBe(1);
    expect(min.getDate()).toBe(1);
    expect(max.getDay()).toBe(5);
    expect(max.getDate()).toBe(5);
  });

  it("on Monday itself, timeMin is that same Monday at 00:00 local", () => {
    const now = new Date(2026, 5, 1, 16, 45); // Monday 2026-06-01
    const min = new Date(weekWindow(now).timeMin);
    expect(min.getDay()).toBe(1);
    expect(min.getDate()).toBe(1);
    expect(min.getHours()).toBe(0);
  });

  it("the window spans Monday→Friday inclusive (4 days + nearly a full day apart)", () => {
    const now = new Date(2026, 5, 3, 0, 0);
    const { timeMin, timeMax } = weekWindow(now);
    const spanMs = new Date(timeMax).getTime() - new Date(timeMin).getTime();
    // Friday 23:59:59.999 minus Monday 00:00:00.000 = 4 days + 23:59:59.999.
    const fourDays = 4 * 24 * 60 * 60 * 1000;
    expect(spanMs).toBeGreaterThan(fourDays);
    expect(spanMs).toBeLessThan(5 * 24 * 60 * 60 * 1000);
  });
});

describe("startBoundary / endBoundary", () => {
  it("startBoundary serializes the ISO date to ISO (UTC midnight for a bare date)", () => {
    expect(startBoundary("2026-04-07")).toBe("2026-04-07T00:00:00.000Z");
  });

  it("endBoundary pushes to end-of-day on the local clock", () => {
    const out = endBoundary("2026-04-11");
    const d = new Date(out);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
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
