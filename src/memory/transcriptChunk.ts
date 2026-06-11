/**
 * Pure, side-effect-free transcript chunker for the memory ingestion pipeline.
 *
 * Joins `"<Speaker>: <text>"` lines into newline-separated chunks of at most
 * `maxChars`, splitting ONLY at line boundaries. The one exception is a single
 * line longer than `maxChars`, which is hard-split into `maxChars`-sized
 * pieces (each emitted as its own chunk) so no content is ever silently lost
 * to an oversized line.
 *
 * The total number of chunks is capped at `maxChunks`; overflow chunks are
 * dropped and reported via `droppedChunks` so the CALLER can log the
 * truncation (no silent caps — this module stays pure and never logs).
 */

export const DEFAULT_CHUNK_MAX_CHARS = 12_000;
export const DEFAULT_MAX_CHUNKS = 12;

export interface ChunkedTranscript {
  /** At most `maxChunks` chunks, each at most `maxChars` characters. */
  chunks: string[];
  /** Number of chunks dropped by the `maxChunks` cap (0 when none). */
  droppedChunks: number;
}

export function chunkTranscript(
  lines: string[],
  maxChars = DEFAULT_CHUNK_MAX_CHARS,
  maxChunks = DEFAULT_MAX_CHUNKS
): ChunkedTranscript {
  const all: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;

  const flush = (): void => {
    if (buffer.length > 0) {
      all.push(buffer.join("\n"));
      buffer = [];
      bufferLen = 0;
    }
  };

  for (const line of lines) {
    // Hard-split exception: a single line that cannot fit in any chunk.
    if (line.length > maxChars) {
      flush();
      for (let i = 0; i < line.length; i += maxChars) {
        all.push(line.slice(i, i + maxChars));
      }
      continue;
    }

    // +1 for the joining "\n" when the buffer already has content.
    const addition = buffer.length > 0 ? line.length + 1 : line.length;
    if (bufferLen + addition > maxChars) {
      flush();
      buffer.push(line);
      bufferLen = line.length;
    } else {
      buffer.push(line);
      bufferLen += addition;
    }
  }
  flush();

  const droppedChunks = Math.max(0, all.length - maxChunks);
  return { chunks: all.slice(0, maxChunks), droppedChunks };
}
