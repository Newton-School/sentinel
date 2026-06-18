import { describe, it, expect } from "vitest";
import {
  markdownToSlackMrkdwn,
  slackReplyText,
  EMPTY_REPLY_FALLBACK,
} from "../src/slack/formatters.js";

describe("slackReplyText (never posts an empty message)", () => {
  it("falls back for undefined / empty / whitespace results", () => {
    expect(slackReplyText(undefined)).toBe(EMPTY_REPLY_FALLBACK);
    expect(slackReplyText("")).toBe(EMPTY_REPLY_FALLBACK);
    expect(slackReplyText("   \n  ")).toBe(EMPTY_REPLY_FALLBACK);
  });

  it("formats and returns real content", () => {
    expect(slackReplyText("**Answer**")).toBe("*Answer*");
  });
});

describe("markdownToSlackMrkdwn", () => {
  describe("bold conversion", () => {
    it("converts **bold** to *bold*", () => {
      expect(markdownToSlackMrkdwn("**Answer**")).toBe("*Answer*");
    });

    it("converts multiple **bold** in same line", () => {
      expect(markdownToSlackMrkdwn("**High** or **Medium** or **Low**")).toBe(
        "*High* or *Medium* or *Low*"
      );
    });

    it("converts __bold__ to *bold*", () => {
      expect(markdownToSlackMrkdwn("__important__")).toBe("*important*");
    });
  });

  describe("italic / single asterisk handling", () => {
    it("leaves *text* as-is (Slack renders it as bold, which is acceptable)", () => {
      expect(markdownToSlackMrkdwn("this is *important* text")).toBe(
        "this is *important* text"
      );
    });

    it("does not break bold conversion when both exist", () => {
      const input = "**bold** and *emphasis* text";
      const result = markdownToSlackMrkdwn(input);
      expect(result).toBe("*bold* and *emphasis* text");
    });
  });

  describe("link conversion", () => {
    it("converts [text](url) to <url|text>", () => {
      expect(markdownToSlackMrkdwn("[click here](https://example.com)")).toBe(
        "<https://example.com|click here>"
      );
    });

    it("converts multiple links", () => {
      const input = "[link1](https://a.com) and [link2](https://b.com)";
      expect(markdownToSlackMrkdwn(input)).toBe(
        "<https://a.com|link1> and <https://b.com|link2>"
      );
    });

    it("handles links with special characters in text", () => {
      expect(markdownToSlackMrkdwn("[PR #7969](https://github.com/pr/7969)")).toBe(
        "<https://github.com/pr/7969|PR #7969>"
      );
    });
  });

  describe("horizontal rules", () => {
    it("removes --- horizontal rules", () => {
      expect(markdownToSlackMrkdwn("above\n---\nbelow")).toBe("above\n\nbelow");
    });

    it("removes *** horizontal rules", () => {
      expect(markdownToSlackMrkdwn("above\n***\nbelow")).toBe("above\n\nbelow");
    });

    it("removes standalone --- line", () => {
      expect(markdownToSlackMrkdwn("---")).toBe("");
    });
  });

  describe("heading conversion", () => {
    it("converts ## Heading to *Heading*", () => {
      expect(markdownToSlackMrkdwn("## Evidence checked")).toBe(
        "*Evidence checked*"
      );
    });

    it("converts ### Heading to *Heading*", () => {
      expect(markdownToSlackMrkdwn("### Sub section")).toBe("*Sub section*");
    });

    it("converts # Heading to *Heading*", () => {
      expect(markdownToSlackMrkdwn("# Title")).toBe("*Title*");
    });
  });

  describe("strikethrough conversion", () => {
    it("converts ~~text~~ to ~text~", () => {
      expect(markdownToSlackMrkdwn("~~removed~~")).toBe("~removed~");
    });
  });

  describe("preserves valid syntax", () => {
    it("preserves code blocks", () => {
      const input = "```\nconst x = 1;\n```";
      expect(markdownToSlackMrkdwn(input)).toBe(input);
    });

    it("preserves inline code", () => {
      expect(markdownToSlackMrkdwn("run `npm test`")).toBe("run `npm test`");
    });

    it("preserves blockquotes", () => {
      expect(markdownToSlackMrkdwn("> quoted text")).toBe("> quoted text");
    });

    it("preserves bullet points", () => {
      expect(markdownToSlackMrkdwn("- item one\n- item two")).toBe(
        "- item one\n- item two"
      );
    });

    it("preserves emoji shortcodes", () => {
      expect(markdownToSlackMrkdwn(":white_check_mark: done")).toBe(
        ":white_check_mark: done"
      );
    });
  });

  describe("real-world Sentinel output", () => {
    it("converts a typical response section", () => {
      const input = `**Answer**

Placements are **up 15%** this week.

---

**Evidence checked**
- **Slack** — found 3 threads ([link](https://slack.com/msg/123))
- **Metabase** — unavailable

**Confidence: High**`;

      const expected = `*Answer*

Placements are *up 15%* this week.

*Evidence checked*
- *Slack* — found 3 threads (<https://slack.com/msg/123|link>)
- *Metabase* — unavailable

*Confidence: High*`;

      expect(markdownToSlackMrkdwn(input)).toBe(expected);
    });
  });

  describe("robustness: malformed/mixed bold + list bullets", () => {
    it("collapses residual ** so no raw double-asterisks leak to Slack", () => {
      // The model sometimes emits malformed bold (label bolded, number left dangling).
      const out = markdownToSlackMrkdwn("**DS enrollments: **117**");
      expect(out).not.toContain("**");
    });

    it("converts a clean bolded metric cleanly", () => {
      expect(markdownToSlackMrkdwn("**DS enrollments: 117**")).toBe("*DS enrollments: 117*");
    });

    it("never leaves ** anywhere in a mixed-bold line", () => {
      expect(markdownToSlackMrkdwn("**A** plus **B** and a stray **")).not.toContain("**");
    });

    it("converts * and + list bullets to • (Slack shows them literally otherwise)", () => {
      expect(markdownToSlackMrkdwn("* first\n* second")).toBe("• first\n• second");
      expect(markdownToSlackMrkdwn("+ plus item")).toBe("• plus item");
      expect(markdownToSlackMrkdwn("  * indented")).toBe("  • indented");
    });

    it("does not mistake a leading bold marker for a bullet", () => {
      expect(markdownToSlackMrkdwn("**Heading**")).toBe("*Heading*");
    });

    it("still preserves - bullets (Slack renders them fine)", () => {
      expect(markdownToSlackMrkdwn("- a\n- b")).toBe("- a\n- b");
    });
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(markdownToSlackMrkdwn("")).toBe("");
    });

    it("handles text with no markdown", () => {
      expect(markdownToSlackMrkdwn("plain text")).toBe("plain text");
    });

    it("does not convert asterisks inside code blocks", () => {
      const input = "```\n**not bold**\n```";
      expect(markdownToSlackMrkdwn(input)).toBe(input);
    });

    it("does not convert asterisks inside inline code", () => {
      expect(markdownToSlackMrkdwn("run `**test**`")).toBe("run `**test**`");
    });
  });
});
