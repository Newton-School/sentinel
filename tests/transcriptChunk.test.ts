import { describe, it, expect } from "vitest";
import { chunkTranscript } from "../src/memory/transcriptChunk.js";

describe("chunkTranscript (pure)", () => {
  it("returns no chunks for empty input", () => {
    const { chunks, droppedChunks } = chunkTranscript([]);
    expect(chunks).toEqual([]);
    expect(droppedChunks).toBe(0);
  });

  it("joins all lines into one chunk when they fit", () => {
    const { chunks, droppedChunks } = chunkTranscript(
      ["Alice: hello", "Bob: hi there"],
      100
    );
    expect(chunks).toEqual(["Alice: hello\nBob: hi there"]);
    expect(droppedChunks).toBe(0);
  });

  it("splits only at line boundaries — never mid-line for normal lines", () => {
    const { chunks } = chunkTranscript(
      ["Alice: aaaa", "Bob: bbbb", "Cara: cccc"],
      // "Alice: aaaa\nBob: bbbb" = 21 chars; adding "\nCara: cccc" exceeds 25.
      25
    );
    expect(chunks).toEqual(["Alice: aaaa\nBob: bbbb", "Cara: cccc"]);
    // No line is ever split across chunks.
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(25);
    }
  });

  it("keeps a chunk that lands exactly on the maxChars boundary intact", () => {
    // "abcde" + "\n" + "fghi" = 10 chars exactly.
    const { chunks } = chunkTranscript(["abcde", "fghi"], 10);
    expect(chunks).toEqual(["abcde\nfghi"]);

    // One char over the boundary → two chunks.
    const over = chunkTranscript(["abcde", "fghij"], 10);
    expect(over.chunks).toEqual(["abcde", "fghij"]);
  });

  it("hard-splits a single giant line longer than maxChars", () => {
    const giant = "x".repeat(25);
    const { chunks, droppedChunks } = chunkTranscript([giant], 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(droppedChunks).toBe(0);
  });

  it("flushes the current buffer before hard-splitting a giant line", () => {
    const giant = "y".repeat(15);
    const { chunks } = chunkTranscript(["Alice: hi", giant, "Bob: bye"], 10);
    expect(chunks).toEqual(["Alice: hi", "y".repeat(10), "y".repeat(5), "Bob: bye"]);
  });

  it("a line of exactly maxChars is NOT hard-split", () => {
    const exact = "z".repeat(10);
    const { chunks } = chunkTranscript([exact], 10);
    expect(chunks).toEqual([exact]);
  });

  it("caps total chunks at maxChunks and reports the dropped count", () => {
    // 30 lines of 10 chars with maxChars 10 → one chunk per line.
    const lines = Array.from({ length: 30 }, (_, i) =>
      `line-${String(i).padStart(2, "0")}`
    );
    const { chunks, droppedChunks } = chunkTranscript(lines, 10, 12);
    expect(chunks).toHaveLength(12);
    expect(droppedChunks).toBe(18);
    expect(chunks[0]).toBe("line-00");
    expect(chunks[11]).toBe("line-11");
  });

  it("uses the documented defaults (12000 chars, 12 chunks)", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `Speaker: utterance ${i}`);
    const { chunks, droppedChunks } = chunkTranscript(lines);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(lines.join("\n"));
    expect(droppedChunks).toBe(0);
  });

  it("never emits a chunk exceeding maxChars", () => {
    const lines = [
      "a".repeat(7),
      "b".repeat(3),
      "c".repeat(11),
      "d".repeat(2),
      "e".repeat(9),
    ];
    const { chunks } = chunkTranscript(lines, 10);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    // All content survives, in order.
    expect(chunks.join("\n").replace(/\n/g, "")).toBe(lines.join(""));
  });
});
