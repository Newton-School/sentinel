import { describe, it, expect } from "vitest";
import {
  slackTsToIso,
  shapeSearchMatches,
  shapeChannelHistory,
  shapeThreadReplies,
} from "../src/mcp/slackShape.js";

describe("slackTsToIso", () => {
  it("converts a Slack ts (seconds.micros) to an ISO-8601 UTC string", () => {
    // 1712448000 = 2024-04-07T00:00:00Z
    expect(slackTsToIso("1712448000.000100")).toBe("2024-04-07T00:00:00.000Z");
  });

  it("preserves sub-second precision down to millis", () => {
    expect(slackTsToIso("1712448000.500000")).toBe("2024-04-07T00:00:00.500Z");
  });
});

describe("shapeSearchMatches", () => {
  it("maps channel/user/text/timestamp/permalink", () => {
    const out = shapeSearchMatches([
      {
        text: "placements risk discussion",
        username: "shiv",
        ts: "1712448000.000000",
        channel: { name: "admissions", id: "C123" },
        permalink: "https://slack/x",
      },
    ]);
    expect(out).toEqual([
      {
        channel: "admissions",
        channelId: "C123",
        user: "shiv",
        text: "placements risk discussion",
        timestamp: "2024-04-07T00:00:00.000Z",
        permalink: "https://slack/x",
      },
    ]);
  });

  it("clamps text to 500 characters", () => {
    const long = "a".repeat(600);
    const out = shapeSearchMatches([
      {
        text: long,
        username: "u",
        ts: "1712448000.000000",
        channel: { name: "c", id: "C1" },
        permalink: "p",
      },
    ]);
    expect(out[0].text).toHaveLength(500);
  });

  it("returns [] for no matches", () => {
    expect(shapeSearchMatches([])).toEqual([]);
  });
});

describe("shapeChannelHistory", () => {
  it("flags hasThread only with thread_ts AND positive reply_count", () => {
    const out = shapeChannelHistory([
      { user: "u1", text: "parent", ts: "1712448000.000000", thread_ts: "1712448000.000000", reply_count: 3 },
    ]);
    expect(out[0].hasThread).toBe(true);
    expect(out[0].replyCount).toBe(3);
  });

  it("does not flag hasThread when reply_count is 0 even with thread_ts", () => {
    const out = shapeChannelHistory([
      { user: "u1", text: "x", ts: "1712448000.000000", thread_ts: "1712448000.000000", reply_count: 0 },
    ]);
    expect(out[0].hasThread).toBe(false);
    expect(out[0].replyCount).toBe(0);
  });

  it("does not flag hasThread when reply_count is missing", () => {
    const out = shapeChannelHistory([
      { user: "u1", text: "x", ts: "1712448000.000000", thread_ts: "1712448000.000000" },
    ]);
    expect(out[0].hasThread).toBe(false);
    expect(out[0].replyCount).toBe(0);
  });

  it("does not flag hasThread when thread_ts is absent", () => {
    const out = shapeChannelHistory([
      { user: "u1", text: "x", ts: "1712448000.000000", reply_count: 5 },
    ]);
    expect(out[0].hasThread).toBe(false);
    expect(out[0].replyCount).toBe(5);
  });

  it("falls back to 'bot' when user is missing", () => {
    const out = shapeChannelHistory([
      { text: "system msg", ts: "1712448000.000000" },
    ]);
    expect(out[0].user).toBe("bot");
  });

  it("clamps text to 500 chars and preserves raw ts plus iso timestamp", () => {
    const out = shapeChannelHistory([
      { user: "u", text: "z".repeat(600), ts: "1712448000.000000" },
    ]);
    expect(out[0].text).toHaveLength(500);
    expect(out[0].ts).toBe("1712448000.000000");
    expect(out[0].timestamp).toBe("2024-04-07T00:00:00.000Z");
  });
});

describe("shapeThreadReplies", () => {
  it("maps user/text/timestamp and falls back to 'bot'", () => {
    const out = shapeThreadReplies([
      { user: "alice", text: "reply one", ts: "1712448000.000000" },
      { text: "bot reply", ts: "1712448060.000000" },
    ]);
    expect(out).toEqual([
      { user: "alice", text: "reply one", timestamp: "2024-04-07T00:00:00.000Z" },
      { user: "bot", text: "bot reply", timestamp: "2024-04-07T00:01:00.000Z" },
    ]);
  });

  it("clamps reply text to 500 chars", () => {
    const out = shapeThreadReplies([
      { user: "u", text: "q".repeat(700), ts: "1712448000.000000" },
    ]);
    expect(out[0].text).toHaveLength(500);
  });
});
