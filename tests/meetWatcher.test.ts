import { describe, it, expect } from "vitest";
import {
  findMeetUrlInEvent,
  filterEventsToJoin,
  type CalendarEventLite,
} from "../src/meet-bot/eventFilter.js";

describe("findMeetUrlInEvent", () => {
  it("prefers hangoutLink when present", () => {
    const event: CalendarEventLite = {
      id: "abc",
      summary: "Standup",
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      start: { dateTime: "2026-04-21T10:00:00Z" },
      end: { dateTime: "2026-04-21T10:30:00Z" },
    };
    expect(findMeetUrlInEvent(event)).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("reads from conferenceData entryPoints video URI", () => {
    const event: CalendarEventLite = {
      id: "abc",
      summary: "Standup",
      conferenceData: {
        entryPoints: [
          { entryPointType: "phone", uri: "tel:+1-555-1234" },
          { entryPointType: "video", uri: "https://meet.google.com/xyz-abcd-efg" },
        ],
      },
      start: { dateTime: "2026-04-21T10:00:00Z" },
      end: { dateTime: "2026-04-21T10:30:00Z" },
    };
    expect(findMeetUrlInEvent(event)).toBe("https://meet.google.com/xyz-abcd-efg");
  });

  it("falls back to extracting from description", () => {
    const event: CalendarEventLite = {
      id: "abc",
      summary: "Review",
      description: "Join the review here: https://meet.google.com/rft-hvuk-mir",
      start: { dateTime: "2026-04-21T10:00:00Z" },
      end: { dateTime: "2026-04-21T10:30:00Z" },
    };
    expect(findMeetUrlInEvent(event)).toBe("https://meet.google.com/rft-hvuk-mir");
  });

  it("falls back to extracting from location", () => {
    const event: CalendarEventLite = {
      id: "abc",
      summary: "Review",
      location: "https://meet.google.com/rft-hvuk-mir",
      start: { dateTime: "2026-04-21T10:00:00Z" },
      end: { dateTime: "2026-04-21T10:30:00Z" },
    };
    expect(findMeetUrlInEvent(event)).toBe("https://meet.google.com/rft-hvuk-mir");
  });

  it("returns null when no Meet URL is present", () => {
    const event: CalendarEventLite = {
      id: "abc",
      summary: "Offline sync",
      description: "See you in the conference room",
      start: { dateTime: "2026-04-21T10:00:00Z" },
      end: { dateTime: "2026-04-21T10:30:00Z" },
    };
    expect(findMeetUrlInEvent(event)).toBeNull();
  });
});

describe("filterEventsToJoin", () => {
  const now = new Date("2026-04-21T10:00:00Z").getTime();

  const upcomingEvent: CalendarEventLite = {
    id: "upcoming",
    summary: "Starting in 2 min",
    hangoutLink: "https://meet.google.com/aaa-bbbb-ccc",
    start: { dateTime: "2026-04-21T10:02:00Z" },
    end: { dateTime: "2026-04-21T10:32:00Z" },
  };

  const inProgressEvent: CalendarEventLite = {
    id: "in-progress",
    summary: "Started 5 min ago",
    hangoutLink: "https://meet.google.com/ddd-eeee-fff",
    start: { dateTime: "2026-04-21T09:55:00Z" },
    end: { dateTime: "2026-04-21T10:25:00Z" },
  };

  const farFutureEvent: CalendarEventLite = {
    id: "far-future",
    summary: "In 1 hour",
    hangoutLink: "https://meet.google.com/ggg-hhhh-iii",
    start: { dateTime: "2026-04-21T11:00:00Z" },
    end: { dateTime: "2026-04-21T11:30:00Z" },
  };

  const pastEvent: CalendarEventLite = {
    id: "past",
    summary: "Ended 10 min ago",
    hangoutLink: "https://meet.google.com/jjj-kkkk-lll",
    start: { dateTime: "2026-04-21T09:20:00Z" },
    end: { dateTime: "2026-04-21T09:50:00Z" },
  };

  const noMeetLinkEvent: CalendarEventLite = {
    id: "no-link",
    summary: "Physical meeting",
    start: { dateTime: "2026-04-21T10:02:00Z" },
    end: { dateTime: "2026-04-21T10:30:00Z" },
  };

  it("joins events starting within the next 2 minutes", () => {
    const result = filterEventsToJoin([upcomingEvent], now, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].event.id).toBe("upcoming");
  });

  it("joins events already in progress", () => {
    const result = filterEventsToJoin([inProgressEvent], now, new Set());
    expect(result).toHaveLength(1);
    expect(result[0].event.id).toBe("in-progress");
  });

  it("skips events far in the future", () => {
    const result = filterEventsToJoin([farFutureEvent], now, new Set());
    expect(result).toHaveLength(0);
  });

  it("skips events that have already ended", () => {
    const result = filterEventsToJoin([pastEvent], now, new Set());
    expect(result).toHaveLength(0);
  });

  it("skips events without a Meet link", () => {
    const result = filterEventsToJoin([noMeetLinkEvent], now, new Set());
    expect(result).toHaveLength(0);
  });

  it("skips events already joined", () => {
    const joined = new Set(["upcoming"]);
    const result = filterEventsToJoin([upcomingEvent], now, joined);
    expect(result).toHaveLength(0);
  });

  it("includes meet URL and duration (remaining until event end)", () => {
    const result = filterEventsToJoin([upcomingEvent], now, new Set());
    expect(result[0].meetUrl).toBe("https://meet.google.com/aaa-bbbb-ccc");
    // Event starts in 2 min and ends 30 min after start → 32 min remaining from now
    expect(result[0].durationSec).toBe(32 * 60);
  });

  it("caps duration at max bot duration (2 hours)", () => {
    const longEvent: CalendarEventLite = {
      id: "long",
      summary: "All-day",
      hangoutLink: "https://meet.google.com/xxx-yyyy-zzz",
      start: { dateTime: "2026-04-21T10:02:00Z" },
      end: { dateTime: "2026-04-21T18:00:00Z" }, // 8 hours
    };
    const result = filterEventsToJoin([longEvent], now, new Set());
    expect(result[0].durationSec).toBe(2 * 60 * 60);
  });

  it("handles multiple eligible events in one call", () => {
    const result = filterEventsToJoin(
      [upcomingEvent, inProgressEvent, farFutureEvent, pastEvent],
      now,
      new Set()
    );
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.event.id).sort()).toEqual(["in-progress", "upcoming"]);
  });
});
