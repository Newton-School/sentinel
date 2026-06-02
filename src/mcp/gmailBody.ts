/**
 * Pure, side-effect-free helpers for extracting a Gmail message body from its
 * MIME part tree. Kept separate from `gmail.ts` (which reads GOOGLE_* env and
 * starts a stdio server on import) so it can be unit-tested in isolation.
 */

/** Minimal structural shape of a Gmail message part (compatible with googleapis). */
export interface GmailPart {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: GmailPart[] | null;
}

/** Decode Gmail's base64url-encoded body data to a UTF-8 string. */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Walk the MIME part tree depth-first and return the decoded `text/plain` body.
 *
 * Gmail nests the plain-text body inside `multipart/alternative` (often itself
 * inside `multipart/mixed` when attachments are present), so inspecting only the
 * top-level parts misses the body for most real messages. This recurses the whole
 * tree and returns the first `text/plain` part found.
 *
 * Falls back to "" if no `text/plain` body exists.
 */
export function extractPlainTextBody(payload: GmailPart | undefined | null): string {
  if (!payload) return "";

  // A text/plain node carrying body data wins immediately.
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart node: recurse depth-first, returning the first text/plain found.
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const found = extractPlainTextBody(part);
      if (found) return found;
    }
    return "";
  }

  // Single-part message with no sub-parts: use its own body data, but only if
  // it isn't a non-plain content type (e.g. text/html or an attachment). A
  // missing mimeType is treated as plain text (single-part text messages).
  if (payload.body?.data && (!payload.mimeType || payload.mimeType === "text/plain")) {
    return decodeBase64Url(payload.body.data);
  }

  return "";
}
