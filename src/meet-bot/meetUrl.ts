const MEET_CODE = /[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}/;
const MEET_URL_RE = new RegExp(
  `https?:\\/\\/meet\\.google\\.com\\/(${MEET_CODE.source})`,
  "i"
);

/**
 * Extracts a Google Meet URL from arbitrary text (typically a calendar event
 * description). Returns null if no Meet URL is found. Normalizes http→https
 * and strips trailing punctuation.
 */
export function extractMeetUrl(input: string): string | null {
  if (!input) return null;

  const match = input.match(MEET_URL_RE);
  if (!match) return null;

  const code = match[1];
  return `https://meet.google.com/${code.toLowerCase()}`;
}

/**
 * Checks whether a string is a valid Google Meet URL with a properly formatted
 * meeting code (xxx-xxxx-xxx or xxxx-xxxx-xxxx).
 */
export function isValidMeetUrl(url: string): boolean {
  if (!url) return false;
  const fullMatch = url.match(
    new RegExp(`^https?:\\/\\/meet\\.google\\.com\\/${MEET_CODE.source}(?:[?#].*)?$`, "i")
  );
  return fullMatch !== null;
}

/**
 * Extracts the meeting code (e.g. "abc-defg-hij") from a Meet URL.
 */
export function extractMeetingCode(url: string): string | null {
  const match = url.match(MEET_URL_RE);
  return match ? match[1].toLowerCase() : null;
}
