/**
 * Converts standard Markdown to Slack mrkdwn format.
 *
 * Slack uses its own formatting syntax:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (not *text*)
 * - Links: <url|text> (not [text](url))
 * - Strikethrough: ~text~ (not ~~text~~)
 * - No horizontal rules, no # headings
 */
/** Shown instead of a blank message when the model returns no usable text. */
export const EMPTY_REPLY_FALLBACK =
  "_I couldn't generate a response just now — the request may have timed out or hit a tool loop. Please try rephrasing or ask again._";

/**
 * Formats an assistant reply for Slack, guaranteeing a non-empty message: a
 * blank / whitespace / undefined result (e.g. the Claude CLI returned an empty
 * `result`) falls back to a notice instead of posting an empty Slack message.
 */
export function slackReplyText(text: string | undefined): string {
  const formatted = markdownToSlackMrkdwn(text ?? "");
  return formatted.trim().length > 0 ? formatted : EMPTY_REPLY_FALLBACK;
}

export function markdownToSlackMrkdwn(text: string): string {
  if (!text) return text;

  // Split into code blocks and non-code segments to avoid converting inside code
  const segments: { text: string; isCode: boolean }[] = [];
  const codeBlockRegex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex), isCode: false });
  }

  return segments
    .map((seg) => (seg.isCode ? seg.text : convertSegment(seg.text)))
    .join("");
}

const BOLD_OPEN = "\x00BO\x00";
const BOLD_CLOSE = "\x00BC\x00";

function convertSegment(text: string): string {
  // Process line by line for line-level conversions
  let result = text
    .split("\n")
    .map((line) => {
      // Remove horizontal rules (---, ***, ___)
      if (/^[-*_]{3,}\s*$/.test(line.trim())) {
        return "";
      }

      // Convert markdown headings to bold (use placeholder to protect from italic pass)
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        return `${BOLD_OPEN}${headingMatch[2]}${BOLD_CLOSE}`;
      }

      // Convert `*`/`+` list bullets to `•` — Slack does NOT render Markdown
      // bullets, so a leading "* " shows literally and reads like broken bold.
      // (A leading "**" is bold, not a bullet — the \s+ guard excludes it; "- "
      // bullets already render acceptably and are left untouched.)
      const bulletMatch = line.match(/^(\s*)[*+]\s+(.*)$/);
      if (bulletMatch) {
        return `${bulletMatch[1]}• ${bulletMatch[2]}`;
      }

      return line;
    })
    .join("\n");

  // Collapse 3+ consecutive newlines into 2 (clean up after removing horizontal rules)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Inline conversions — protect inline code first
  result = convertInline(result);

  return result;
}

function convertInline(text: string): string {
  // Split by inline code to avoid converting inside backticks
  const parts: { text: string; isCode: boolean }[] = [];
  const inlineCodeRegex = /`[^`]+`/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineCodeRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isCode: false });
    }
    parts.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isCode: false });
  }

  return parts
    .map((part) => {
      if (part.isCode) return part.text;

      let t = part.text;

      // Convert markdown links [text](url) → <url|text>
      t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

      // Convert ~~strikethrough~~ → ~strikethrough~
      t = t.replace(/~~(.+?)~~/g, "~$1~");

      // Convert **bold** → placeholder (to protect from italic conversion)
      t = t.replace(/\*\*(.+?)\*\*/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

      // Convert __bold__ → placeholder
      t = t.replace(/__(.+?)__/g, `${BOLD_OPEN}$1${BOLD_CLOSE}`);

      // Note: we intentionally do NOT convert *text* → _text_
      // In Slack mrkdwn, *text* is bold (which is the desired output).
      // Claude may use *text* for either Markdown italic or Slack bold —
      // either way, Slack renders it as bold, which is acceptable.

      // Restore bold placeholders → *bold*
      t = t.replaceAll(BOLD_OPEN, "*");
      t = t.replaceAll(BOLD_CLOSE, "*");

      // Collapse any residual run of 2+ asterisks into one. Malformed/mixed bold
      // from the model (e.g. "**label: **117**") otherwise leaves a raw "**" that
      // Slack shows literally; converted bold is single "*" so this only catches
      // leftovers.
      t = t.replace(/\*\*+/g, "*");

      return t;
    })
    .join("");
}
