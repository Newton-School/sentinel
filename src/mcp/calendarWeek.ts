/**
 * Pure, side-effect-free helpers for the Google Calendar MCP server.
 *
 * No `process.env` reads, no googleapis client, no server bootstrap — `calendar.ts`
 * performs the authenticated API calls and passes a real `now`, the calendar's
 * IANA timezone, and the parsed event items through these helpers.
 *
 * The "this week" window is computed in the CALENDAR's timezone (an IANA zone
 * such as "Asia/Kolkata"), not the host's local clock, then serialized as the
 * corresponding UTC ISO instants. The timezone math is done with the built-in
 * `Intl.DateTimeFormat` (no external deps): for a target instant we read the
 * wall-clock fields the zone would display and derive its UTC offset.
 */

export interface WeekWindow {
  /** ISO-8601 UTC string for the start boundary (Monday 00:00:00.000 in `timeZone`). */
  timeMin: string;
  /** ISO-8601 UTC string for the end boundary (Friday 23:59:59.999 in `timeZone`). */
  timeMax: string;
}

/**
 * Read the wall-clock fields (year, month, day, weekday, h/m/s) that `timeZone`
 * would display for the instant `date`, using `Intl.DateTimeFormat`.
 */
interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  weekday: number; // 0=Sunday .. 6=Saturday
  hour: number;
  minute: number;
  second: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  // `hour12: false` can yield "24" for midnight in some engines; normalize to 0.
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Offset (in minutes) that must be ADDED to a UTC instant to obtain the
 * wall-clock time displayed in `timeZone` at that instant. e.g. for
 * "Asia/Kolkata" this is +330; for "America/New_York" in summer it is -240.
 */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  // The UTC timestamp that, read as a UTC clock, shows the same wall-clock fields.
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Convert a wall-clock date-time IN `timeZone` to the matching UTC instant.
 *
 * We first guess the UTC instant by treating the wall-clock fields as UTC, then
 * correct by the zone's offset AT that instant. A single re-evaluation of the
 * offset handles DST transitions correctly for ordinary midday/edge times.
 */
function zonedWallTimeToUTC(
  timeZone: string,
  year: number,
  month: number, // 1-12
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number
): Date {
  const naiveUTC = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const guess = new Date(naiveUTC);
  const offset1 = tzOffsetMinutes(guess, timeZone);
  let instant = new Date(naiveUTC - offset1 * 60000);
  // Re-check the offset at the computed instant; if the zone's offset changed
  // (DST boundary), apply the corrected offset.
  const offset2 = tzOffsetMinutes(instant, timeZone);
  if (offset2 !== offset1) {
    instant = new Date(naiveUTC - offset2 * 60000);
  }
  return instant;
}

/** Add `days` calendar days to a (year, month, day) triple, normalizing overflow. */
function addDays(
  year: number,
  month: number, // 1-12
  day: number,
  days: number
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/**
 * Compute the current week's Monday→Friday window relative to `now`, evaluated
 * in `timeZone` (an IANA zone).
 *
 * The weekday and calendar date are read from the zone's wall clock, so Monday
 * is found by subtracting `(weekday+6)%7` days (Sunday=0 rolls back to the
 * previous Monday); Friday is Monday+4. Boundaries are Monday 00:00:00.000 and
 * Friday 23:59:59.999 in `timeZone`, serialized as the corresponding UTC ISO.
 */
export function weekWindow(now: Date, timeZone: string): WeekWindow {
  const p = zonedParts(now, timeZone);
  const backToMonday = (p.weekday + 6) % 7;

  const mon = addDays(p.year, p.month, p.day, -backToMonday);
  const fri = addDays(p.year, p.month, p.day, -backToMonday + 4);

  const timeMin = zonedWallTimeToUTC(
    timeZone,
    mon.year,
    mon.month,
    mon.day,
    0,
    0,
    0,
    0
  ).toISOString();
  const timeMax = zonedWallTimeToUTC(
    timeZone,
    fri.year,
    fri.month,
    fri.day,
    23,
    59,
    59,
    999
  ).toISOString();

  return { timeMin, timeMax };
}

/** Parse a "YYYY-MM-DD" (optionally with time) date string into y/m/d fields. */
function parseDateParts(dateStr: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  // Fall back to Date parsing for non-ISO inputs; use UTC fields.
  const d = new Date(dateStr);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Compute timeMin from an explicit `start_date` (ISO date string): start-of-day
 * (00:00:00.000) of that date IN `timeZone`, serialized as UTC ISO.
 */
export function startBoundary(startDate: string, timeZone: string): string {
  const { year, month, day } = parseDateParts(startDate);
  return zonedWallTimeToUTC(timeZone, year, month, day, 0, 0, 0, 0).toISOString();
}

/**
 * Compute timeMax from an explicit `end_date`: end-of-day (23:59:59.999) of that
 * date IN `timeZone`, serialized as UTC ISO.
 */
export function endBoundary(endDate: string, timeZone: string): string {
  const { year, month, day } = parseDateParts(endDate);
  return zonedWallTimeToUTC(timeZone, year, month, day, 23, 59, 59, 999).toISOString();
}

export interface CalendarEvent {
  id?: string | null;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
  description?: string | null;
  location?: string | null;
  hangoutLink?: string | null;
  attendees?: Array<{
    email?: string | null;
    displayName?: string | null;
    responseStatus?: string | null;
  }> | null;
  organizer?: { email?: string | null } | null;
}

export interface MappedEvent {
  id: string | null | undefined;
  summary: string;
  start: string | null | undefined;
  end: string | null | undefined;
  description: string | undefined;
  location: string | null | undefined;
  meetLink: string | null | undefined;
  attendees: Array<{
    email: string | null | undefined;
    displayName: string | null | undefined;
    responseStatus: string | null | undefined;
  }>;
  organizer: string | null | undefined;
}

/**
 * Map a full calendar event to the `calendar_list_events` summary shape.
 * `start`/`end` prefer `dateTime` (timed events) over `date` (all-day events);
 * a missing title becomes "(no title)"; description is clamped to 300 chars.
 */
export function mapEvent(event: CalendarEvent): MappedEvent {
  return {
    id: event.id,
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    description: event.description?.slice(0, 300),
    location: event.location,
    meetLink: event.hangoutLink,
    attendees: (event.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
    })),
    organizer: event.organizer?.email,
  };
}

export interface MappedSearchEvent {
  id: string | null | undefined;
  summary: string;
  start: string | null | undefined;
  end: string | null | undefined;
  meetLink: string | null | undefined;
  attendeeCount: number;
}

/** Map an event to the lighter `calendar_search` shape (attendee count only). */
export function mapSearchEvent(event: CalendarEvent): MappedSearchEvent {
  return {
    id: event.id,
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date,
    end: event.end?.dateTime ?? event.end?.date,
    meetLink: event.hangoutLink,
    attendeeCount: event.attendees?.length ?? 0,
  };
}
