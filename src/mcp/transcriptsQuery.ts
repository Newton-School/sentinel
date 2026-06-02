/**
 * Pure, side-effect-free helpers for the Meeting-transcripts MCP server.
 *
 * No `process.env` reads, no googleapis client, no server bootstrap — `transcripts.ts`
 * performs the authenticated Drive/Docs calls and passes a real `now` + the
 * parsed responses through these helpers.
 */

/**
 * Build the Drive `q` filter for `transcript_search`.
 *
 * Always restricts to non-trashed Google Docs modified after `now - days_back`.
 * When `query` is given, ORs a name/fullText contains-match (single quotes in
 * the query are backslash-escaped); otherwise it falls back to titles
 * containing the word "transcript".
 *
 * `now` is injected so the `modifiedTime` boundary is deterministic.
 */
export function buildSearchQuery(
  days_back: number,
  now: Date,
  query?: string
): string {
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - days_back);
  const afterStr = afterDate.toISOString();

  let driveQuery = `mimeType='application/vnd.google-apps.document' and modifiedTime > '${afterStr}' and trashed = false`;

  if (query) {
    const escaped = query.replace(/'/g, "\\'");
    driveQuery += ` and (name contains '${escaped}' or fullText contains '${escaped}')`;
  } else {
    driveQuery += ` and name contains 'transcript'`;
  }

  return driveQuery;
}

/**
 * Build the Drive `q` filter for `transcript_list_recent`: non-trashed Google
 * Docs modified after `now - days` whose name contains "transcript".
 */
export function buildRecentQuery(days: number, now: Date): string {
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - days);
  const afterStr = afterDate.toISOString();

  return `mimeType='application/vnd.google-apps.document' and modifiedTime > '${afterStr}' and trashed = false and name contains 'transcript'`;
}

/** Minimal structural shape of a Google Doc body (compatible with googleapis). */
export interface GoogleDocBody {
  body?: {
    content?: Array<{
      paragraph?: {
        elements?: Array<{ textRun?: { content?: string | null } | null }> | null;
      } | null;
    }> | null;
  } | null;
}

/**
 * Extract the plain text of a Google Doc by concatenating every paragraph's
 * `textRun.content`. Non-paragraph structural elements (tables, section breaks,
 * etc.) are skipped, matching the server's behavior.
 */
export function extractDocText(doc: GoogleDocBody): string {
  let fullText = "";
  for (const element of doc.body?.content ?? []) {
    if (element.paragraph) {
      for (const elem of element.paragraph.elements ?? []) {
        if (elem.textRun?.content) {
          fullText += elem.textRun.content;
        }
      }
    }
  }
  return fullText;
}

export interface TranscriptReadResult {
  characterCount: number;
  truncated: boolean;
  content: string;
}

/**
 * Apply the `max_length` truncation policy to extracted doc text. `truncated`
 * reflects whether the FULL text exceeded `max_length`; `characterCount` is the
 * length of the full (pre-truncation) text.
 */
export function truncateDocText(
  fullText: string,
  max_length: number
): TranscriptReadResult {
  const truncated = fullText.length > max_length;
  const content = truncated ? fullText.slice(0, max_length) : fullText;
  return { characterCount: fullText.length, truncated, content };
}

export interface DriveFile {
  id?: string | null;
  name?: string | null;
  createdTime?: string | null;
  modifiedTime?: string | null;
  webViewLink?: string | null;
  owners?: Array<{ emailAddress?: string | null }> | null;
}

export interface MappedSearchFile {
  id: string | null | undefined;
  name: string | null | undefined;
  createdTime: string | null | undefined;
  modifiedTime: string | null | undefined;
  webViewLink: string | null | undefined;
  owner: string | null | undefined;
}

/** Map Drive files for `transcript_search` (includes first owner's email). */
export function mapSearchFiles(files: DriveFile[]): MappedSearchFile[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
    owner: file.owners?.[0]?.emailAddress,
  }));
}

export interface MappedRecentFile {
  id: string | null | undefined;
  name: string | null | undefined;
  createdTime: string | null | undefined;
  modifiedTime: string | null | undefined;
  webViewLink: string | null | undefined;
}

/** Map Drive files for `transcript_list_recent` (no owner field). */
export function mapRecentFiles(files: DriveFile[]): MappedRecentFile[] {
  return files.map((file) => ({
    id: file.id,
    name: file.name,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    webViewLink: file.webViewLink,
  }));
}
