import { extractMeetUrl, isValidMeetUrl } from "./meetUrl.js";

/**
 * A trimmed-down calendar event shape — what we need to decide whether to join.
 */
export interface CalendarEventLite {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType?: string;
      uri?: string;
    }>;
  };
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
}

export interface EventToJoin {
  event: CalendarEventLite;
  meetUrl: string;
  durationSec: number;
}

// Join events starting within the next 2 minutes OR already in progress.
const JOIN_WINDOW_MS_AHEAD = 2 * 60 * 1000;
const MAX_BOT_DURATION_SEC = 2 * 60 * 60; // matches joiner default

/**
 * Extracts a Meet URL from a Google Calendar event. Checks hangoutLink first,
 * then conferenceData entry points, then falls back to parsing description/location.
 */
export function findMeetUrlInEvent(event: CalendarEventLite): string | null {
  if (event.hangoutLink && isValidMeetUrl(event.hangoutLink)) {
    return event.hangoutLink;
  }

  const videoEntryPoint = event.conferenceData?.entryPoints?.find(
    (ep) => ep.entryPointType === "video"
  );
  if (videoEntryPoint?.uri && isValidMeetUrl(videoEntryPoint.uri)) {
    return videoEntryPoint.uri;
  }

  if (event.description) {
    const fromDesc = extractMeetUrl(event.description);
    if (fromDesc) return fromDesc;
  }

  if (event.location) {
    const fromLoc = extractMeetUrl(event.location);
    if (fromLoc) return fromLoc;
  }

  return null;
}

/**
 * Given a list of calendar events and the current time, returns events the
 * bot should join right now: either starting within 2 min or currently in progress.
 * Skips events that are missing Meet links, already ended, or already joined.
 */
export function filterEventsToJoin(
  events: CalendarEventLite[],
  nowMs: number,
  joinedIds: Set<string>
): EventToJoin[] {
  const results: EventToJoin[] = [];

  for (const event of events) {
    if (joinedIds.has(event.id)) continue;

    const startStr = event.start.dateTime;
    const endStr = event.end.dateTime;
    if (!startStr || !endStr) continue;

    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;

    const startsWithinWindow = startMs - nowMs <= JOIN_WINDOW_MS_AHEAD;
    const notYetEnded = endMs > nowMs;
    if (!startsWithinWindow || !notYetEnded) continue;

    const meetUrl = findMeetUrlInEvent(event);
    if (!meetUrl) continue;

    const remainingSec = Math.ceil((endMs - nowMs) / 1000);
    const durationSec = Math.min(Math.max(remainingSec, 60), MAX_BOT_DURATION_SEC);

    results.push({ event, meetUrl, durationSec });
  }

  return results;
}
