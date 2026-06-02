/**
 * Generic, side-effect-free pagination helper for cursor/page-token based APIs.
 *
 * Repeatedly invokes `fetchPage(cursor)`, accumulating `items` across pages,
 * threading each page's `next` cursor into the following call. Stops when:
 *   - a page returns no `next` cursor (exhausted), OR
 *   - `maxItems` items have been collected (the result is sliced to `maxItems`), OR
 *   - `maxPages` pages have been fetched (hard safety cap so we never loop unbounded).
 *
 * `truncated` is set to `true` when more results were available but we stopped at
 * one of the `maxItems`/`maxPages` bounds — callers use this to log/report that
 * the output was capped, so there are no silent caps.
 *
 * No logging, fetch, or env reads happen here — callers wire in the actual page
 * fetch and decide what to do with `truncated`.
 */
export async function paginate<T>(opts: {
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>;
  maxItems: number;
  /** Hard cap on number of pages fetched (default 20) to bound the loop. */
  maxPages?: number;
}): Promise<{ items: T[]; truncated: boolean }> {
  const { fetchPage, maxItems } = opts;
  const maxPages = opts.maxPages ?? 20;

  const items: T[] = [];
  let cursor: string | undefined = undefined;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const { items: pageItems, next } = await fetchPage(cursor);
    items.push(...pageItems);

    if (items.length >= maxItems) {
      // Hit the item budget. If we collected more than allowed, or there are
      // still more pages to fetch, the output is being capped → truncated.
      if (items.length > maxItems || (next && next.length > 0)) {
        truncated = true;
      }
      items.length = Math.min(items.length, maxItems);
      return { items, truncated };
    }

    if (!next || next.length === 0) {
      // No further pages — fully exhausted.
      return { items, truncated: false };
    }

    cursor = next;
  }

  // Fell out of the loop because we hit the hard page cap with more available.
  return { items, truncated: true };
}
