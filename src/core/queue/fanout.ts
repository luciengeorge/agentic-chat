/**
 * Fan-out over a long PDF (section 05.5). The ingest workflow cuts a long document into page ranges and starts one
 * child run per range, a batch at a time. Nothing here touches the database or the network: the ingest workflow
 * calls it from its own body, so it must stay pure and deterministic.
 */

export interface PageRange {
  /** 1-based, inclusive. */
  from: number;
  to: number;
}

/** What a child run reports back for its range. */
export type RangeResult = { status: "completed"; chunks: number } | { status: "failed"; error: string };

/** Cuts pages 1 to `pages` into ranges of `size`, in order. Every page is in exactly one range; the last may be
 * shorter. */
export function pageRanges(pages: number, size: number): PageRange[] {
  const ranges = [];
  for (let from = 1; from <= pages; from += size) ranges.push({ from, to: Math.min(pages, from + size - 1) });
  return ranges;
}

/**
 * Runs `child` for every range, `batch` at a time: a batch starts once the one before has finished. `child` gets
 * the range's index in `ranges`, which numbers its chunks. Throws once a batch holds a failed range, before
 * starting the next. Returns the chunks written in all.
 */
export async function fanOut(
  ranges: readonly PageRange[],
  batch: number,
  child: (range: PageRange, index: number) => Promise<RangeResult>,
): Promise<number> {
  let chunks = 0;
  for (let i = 0; i < ranges.length; i += batch) {
    const results = await Promise.all(ranges.slice(i, i + batch).map((range, offset) => child(range, i + offset)));
    for (const result of results) {
      if (result.status === "failed") throw new Error(`a page range failed: ${result.error}`);
      chunks += result.chunks;
    }
  }
  return chunks;
}
