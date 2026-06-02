import { describe, it, expect, vi } from "vitest";
import { paginate } from "../src/mcp/paginate.js";

describe("paginate", () => {
  it("returns a single page untouched when there is no next cursor", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1, 2, 3], next: undefined }));

    const result = await paginate({ fetchPage, maxItems: 100 });

    expect(result).toEqual({ items: [1, 2, 3], truncated: false });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    // First call uses an undefined cursor.
    expect(fetchPage).toHaveBeenCalledWith(undefined);
  });

  it("follows next cursors across pages and accumulates items", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      "": { items: [1, 2], next: "c1" },
      c1: { items: [3, 4], next: "c2" },
      c2: { items: [5], next: undefined },
    };
    const fetchPage = vi.fn(async (cursor: string | undefined) => pages[cursor ?? ""]);

    const result = await paginate({ fetchPage, maxItems: 100 });

    expect(result.items).toEqual([1, 2, 3, 4, 5]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    // Cursor from each page is threaded into the next call.
    expect(fetchPage).toHaveBeenNthCalledWith(1, undefined);
    expect(fetchPage).toHaveBeenNthCalledWith(2, "c1");
    expect(fetchPage).toHaveBeenNthCalledWith(3, "c2");
  });

  it("respects maxItems: slices to maxItems and reports truncated:true", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      "": { items: [1, 2, 3], next: "c1" },
      c1: { items: [4, 5, 6], next: "c2" },
    };
    const fetchPage = vi.fn(async (cursor: string | undefined) => pages[cursor ?? ""]);

    const result = await paginate({ fetchPage, maxItems: 4 });

    expect(result.items).toEqual([1, 2, 3, 4]);
    expect(result.truncated).toBe(true);
  });

  it("treats reaching exactly maxItems with no further pages as NOT truncated", async () => {
    const fetchPage = vi.fn(async () => ({ items: [1, 2, 3], next: undefined }));

    const result = await paginate({ fetchPage, maxItems: 3 });

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(false);
  });

  it("treats hitting maxItems exactly while more pages remain as truncated", async () => {
    const pages: Record<string, { items: number[]; next?: string }> = {
      "": { items: [1, 2, 3], next: "c1" },
    };
    const fetchPage = vi.fn(async (cursor: string | undefined) => pages[cursor ?? ""]);

    const result = await paginate({ fetchPage, maxItems: 3 });

    expect(result.items).toEqual([1, 2, 3]);
    expect(result.truncated).toBe(true);
    // Should not fetch the second page since maxItems is already reached.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("respects maxPages as a hard safety cap and reports truncated:true", async () => {
    // Every page advertises a next cursor, so only maxPages bounds the loop.
    const fetchPage = vi.fn(async (cursor: string | undefined) => ({
      items: [Number(cursor ?? 0)],
      next: String(Number(cursor ?? 0) + 1),
    }));

    const result = await paginate({ fetchPage, maxItems: 1000, maxPages: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it("defaults maxPages to 20 when not provided", async () => {
    const fetchPage = vi.fn(async (cursor: string | undefined) => ({
      items: [Number(cursor ?? 0)],
      next: String(Number(cursor ?? 0) + 1),
    }));

    const result = await paginate({ fetchPage, maxItems: 1_000_000 });

    expect(fetchPage).toHaveBeenCalledTimes(20);
    expect(result.items).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  it("handles an empty first page", async () => {
    const fetchPage = vi.fn(async () => ({ items: [] as number[], next: undefined }));

    const result = await paginate({ fetchPage, maxItems: 100 });

    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
