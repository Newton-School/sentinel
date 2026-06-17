import { describe, it, expect } from "vitest";
import { chunkMrkdwn, buildReplyBlocks, acknowledgedBlocks } from "../src/slack/feedbackBlocks.js";

describe("chunkMrkdwn", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkMrkdwn("hello world", 2900)).toEqual(["hello world"]);
  });

  it("splits long text on newline boundaries within the limit", () => {
    const para = "x".repeat(2000);
    const text = `${para}\n${para}\n${para}`;
    const chunks = chunkMrkdwn(text, 2900);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2900);
    // No content lost (modulo the joining newlines).
    expect(chunks.join("\n").replace(/\n/g, "")).toBe(text.replace(/\n/g, ""));
  });

  it("hard-splits a single oversized line", () => {
    const chunks = chunkMrkdwn("y".repeat(7000), 2900);
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(2900);
  });
});

describe("buildReplyBlocks", () => {
  it("renders the answer as section blocks plus an actions block with two feedback buttons", () => {
    const blocks = buildReplyBlocks("Here is the **answer**.", "TRACE-1");
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThanOrEqual(1);
    expect((sections[0] as any).text.type).toBe("mrkdwn");

    const actions = blocks.find((b) => b.type === "actions") as any;
    expect(actions).toBeTruthy();
    expect(actions.block_id).toBe("sentinel_feedback");
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual(["feedback_up", "feedback_down"]);
    // Each button carries the trace id so the click can be attributed.
    for (const e of actions.elements) expect(e.value).toBe("TRACE-1");
    expect(actions.elements[0].text.text).toContain("👍");
    expect(actions.elements[1].text.text).toContain("👎");
  });

  it("splits a long answer across multiple section blocks (Slack 3000-char limit)", () => {
    const long = "word ".repeat(2000); // ~10k chars
    const blocks = buildReplyBlocks(long, "T");
    const sections = blocks.filter((b) => b.type === "section");
    expect(sections.length).toBeGreaterThan(1);
    for (const s of sections) expect((s as any).text.text.length).toBeLessThanOrEqual(3000);
  });
});

describe("acknowledgedBlocks", () => {
  it("drops the actions block and appends a thank-you context", () => {
    const blocks = buildReplyBlocks("answer", "T");
    const acked = acknowledgedBlocks(blocks, "positive", "U7");
    expect(acked.find((b) => b.type === "actions")).toBeUndefined();
    const ctx = acked.find((b) => b.type === "context") as any;
    expect(ctx).toBeTruthy();
    expect(ctx.elements[0].text).toMatch(/👍/);
    expect(ctx.elements[0].text).toContain("U7");
    // The original answer sections are preserved.
    expect(acked.filter((b) => b.type === "section").length).toBe(
      blocks.filter((b) => b.type === "section").length
    );
  });

  it("shows 👎 for negative feedback", () => {
    const acked = acknowledgedBlocks(buildReplyBlocks("a", "T"), "negative", "U7");
    const ctx = acked.find((b) => b.type === "context") as any;
    expect(ctx.elements[0].text).toMatch(/👎/);
  });
});
