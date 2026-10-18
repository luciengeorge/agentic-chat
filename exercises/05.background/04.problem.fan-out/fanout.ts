// 👨‍💼 Kestrel's FCA annual return is 3,000 pages. Ingested as one step, a failure on page 2,900 throws away the
//    work on the 2,899 before it, and nothing is searchable until the very end. Kestrel cuts it into page ranges
//    and ingests them as child runs, side by side, a batch at a time.

/**
 * Fan-out over a long PDF (section 05.4). The ingest workflow cuts a long document into page ranges and starts one
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
  // 🐨 Start at page 1. Each range runs from `from` to `from + size - 1`, both included, but never past `pages`.
  //    The next range starts on the page after it. Stop once you've passed the last page.
  //
  // 🦉 Why inclusive ends, and the classic off-by-one. Pages 1 to 250 are 250 pages: the end is `from + size - 1`.
  //    Write `from + size` and every range's last page is also the next range's first: page 251 is parsed twice,
  //    and its chunks are written by two children. Step `from` by `size + 1` and page 251 is never read at all.
  // 🦉 Why clip the last range. 3,000 is a multiple of 250, so every range is full. Seven pages in ranges of two
  //    aren't: the last range is page 7 alone. A range that runs to page 8 is refused by readPages (section 03.4).
  throw new Error(`pageRanges(${pages} pages, ranges of ${size}) isn't written yet`);
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
  // 🐨 Take the ranges `batch` at a time, in order. Start every child in the batch at once, and wait for all of
  //    them before starting the next batch.
  // 🐨 Give each child its range and that range's index in `ranges` (not its place in the batch).
  // 🐨 When a batch is done: if any result is "failed", throw an Error that carries its `error`, and start
  //    nothing more. Otherwise add up the chunks, and return the total once every batch is done.
  //
  // 💰 `ranges.slice(i, i + batch)` is one batch. `Promise.all(list.map(async (range, offset) => ...))` starts them
  //    all and waits for every one.
  //
  // 🦉 Why children at all. Each child is a workflow run of its own, with its own steps and retries. A range that
  //    fails is retried alone; the other eleven keep what they wrote. And the parse of 250 pages fits easily in one
  //    step, where 3,000 pages and their 5,274 chunks would be one big step that has to succeed all at once.
  // 🦉 Why batches. Twelve children could all start at once, but a document with 40,000 pages would start 160, and
  //    each one holds a database connection while it writes. Ten at a time bounds that, whatever the size.
  // 🦉 Why the index, not the offset. The child writes its chunks from `index * 100,000`, so ranges sort in page
  //    order and never collide. Pass the offset in the batch, the classic mistake, and range 10 (pages 2,251 to
  //    2,500) writes from 0 again: on top of range 0's chunks, which it deletes first.
  // 🦉 Why stop on a failure. The parent then marks the document failed. Starting more children for a document
  //    that will never be ready only spends work.
  // 🦉 Why this runs in the workflow body. The parent workflow calls fanOut directly, not through a step, so it may
  //    do no I/O and must decide the same way every time the run is replayed. It only calls `child`, which
  //    creates a hook and starts the child run; Workflow records both.
  //
  // 📜 https://workflow-sdk.dev/docs/foundations/hooks
  //
  // 🚨 The tests check that the filing's 3,000 pages make 12 ranges with every page in exactly one, that a short
  //    last range is clipped, that at most `batch` children run at once and a batch waits for the one before, that
  //    each child gets its own index, that a failed range stops the fan-out before the next batch, and, in a real
  //    run, that the filing ingests as 12 children with the CHG-2026-0612 note on page 2,417 at ordinal 900,333.
  throw new Error(`fanOut(${ranges.length} ranges, ${batch} at a time, ${typeof child}) isn't written yet`);
}
