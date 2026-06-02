/**
 * Pure, side-effect-free helpers for the Google Calendar MCP server.
 *
 * No `process.env` reads, no googleapis client, no server bootstrap — `calendar.ts`
 * performs the authenticated API calls and passes a real `now` + the parsed
 * event items through these helpers.
 *
 * KNOWN LATENT BUG (characterized, not fixed here): `weekWindow` derives the
 * Monday/Friday boundaries from the host's LOCAL time (`getDay`/`setHours`) and
 * then serializes with `toISOString()` (UTC). On a host whose timezone is not
 * UTC, the emitted boundaries are shifted by the UTC offset, so the "this week"
 * window does not align to local midnight Monday → local 23:59:59 Friday as a
 * UTC reader would expect. Tests below assert the ACTUAL current behavior.
 */

export interface WeekWindow {
  /** ISO-8601 string for the start boundary (local Monday 00:00:00.000). */
  timeMin: string;
  /** ISO-8601 string for the end boundary (local Friday 23:59:59.999). */
  timeMax: string;
}

/**
 * Compute the current week's Monday→Friday window relative to `now`.
 *
 * Monday is found by subtracting `(getDay()+6)%7` days (Sunday=0 maps to 6 so it
 * rolls back to the previous Monday); Friday is Monday+4. Hours are set on the
 * LOCAL clock, then `.toISOString()` converts to UTC — see the module-level note
 * about the resulting timezone skew.
 */
export function weekWindow(now: Date): WeekWindow {
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);

  const friday = new Date(now);
  friday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 4);
  friday.setHours(23, 59, 59, 999);

  return { timeMin: monday.toISOString(), timeMax: friday.toISOString() };
}

/**
 * Compute timeMin from an explicit `start_date` (ISO date string). Mirrors the
 * server: `new Date(start_date).toISOString()`.
 */
export function startBoundary(startDate: string): string {
  return new Date(startDate).toISOString();
}

/**
 * Compute timeMax from an explicit `end_date`, pushed to end-of-day (local
 * 23:59:59.999) before serializing to UTC. Mirrors the server.
 */
export function endBoundary(endDate: string): string {
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
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
