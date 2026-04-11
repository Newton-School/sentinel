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

      // Convert remaining standalone *italic* → _italic_
      t = t.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

      // Restore bold placeholders → *bold*
      t = t.replaceAll(BOLD_OPEN, "*");
      t = t.replaceAll(BOLD_CLOSE, "*");

      return t;
    })
    .join("");
}
