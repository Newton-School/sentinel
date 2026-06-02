/**
 * Pure, side-effect-free helpers for the Gmail MCP server.
 *
 * No `process.env` reads, no googleapis client, no server bootstrap — `gmail.ts`
 * performs the authenticated API calls and passes the parsed message details
 * (and a real `now`) through these helpers. Plain-text body extraction lives in
 * `gmailBody.ts`.
 */

/** A Gmail message header as returned by the API. */
export interface GmailHeader {
  name?: string | null;
  value?: string | null;
}

/**
 * Case-insensitive header lookup. Returns the first matching header value, or
 * "" when the header is absent.
 */
export function getHeader(
  headers: GmailHeader[] | undefined | null,
  name: string
): string {
  return (
    (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase())
      ?.value ?? ""
  );
}

/**
 * Build the `after:YYYY/MM/DD` Gmail search query for "last N days", optionally
 * filtered by label. `now` is injected so the date math is deterministic.
 *
 * Gmail's `after:` operator expects a slash-separated date with zero-padded
 * month/day. Uses local-date components of `now` minus `days`.
 */
export function buildRecentQuery(
  days: number,
  now: Date,
  label?: string
): string {
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - days);
  const afterStr = `${afterDate.getFullYear()}/${String(
    afterDate.getMonth() + 1
  ).padStart(2, "0")}/${String(afterDate.getDate()).padStart(2, "0")}`;

  let query = `after:${afterStr}`;
  if (label) query += ` label:${label}`;
  return query;
}

/** Minimal shape of a Gmail message detail (compatible with googleapis). */
export interface GmailMessageDetail {
  id?: string | null;
  threadId?: string | null;
  snippet?: string | null;
  labelIds?: string[] | null;
  payload?: { headers?: GmailHeader[] | null } | null;
}

export interface ShapedSearchResult {
  id: string | null | undefined;
  threadId: string | null | undefined;
  snippet: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  labelIds: string[] | null | undefined;
}

/**
 * Shape a `gmail_search` result row: pull From/To/Cc/Subject/Date headers out of
 * the message payload, plus the snippet and label ids.
 */
export function shapeSearchResult(
  id: string | null | undefined,
  detail: GmailMessageDetail
): ShapedSearchResult {
  const headers = detail.payload?.headers ?? [];
  return {
    id,
    threadId: detail.threadId,
    snippet: detail.snippet ?? "",
    from: getHeader(headers, "From"),
    to: getHeader(headers, "To"),
    cc: getHeader(headers, "Cc"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
    labelIds: detail.labelIds,
  };
}

export interface ShapedListResult {
  id: string | null | undefined;
  threadId: string | null | undefined;
  snippet: string;
  from: string;
  subject: string;
  date: string;
}

/**
 * Shape a `gmail_list_recent` result row: From/Subject/Date headers plus the
 * snippet (no To/Cc/labels, matching the lighter list view).
 */
export function shapeListResult(
  id: string | null | undefined,
  detail: GmailMessageDetail
): ShapedListResult {
  const headers = detail.payload?.headers ?? [];
  return {
    id,
    threadId: detail.threadId,
    snippet: detail.snippet ?? "",
    from: getHeader(headers, "From"),
    subject: getHeader(headers, "Subject"),
    date: getHeader(headers, "Date"),
  };
}
