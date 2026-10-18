// @vitest-environment node
import { describe, expect, it } from "vitest";

import { fanOut, type PageRange, pageRanges, type RangeResult } from "#learn/queue/fanout";

const span = (range: PageRange) => `${range.from}-${range.to}`;

describe("page ranges", () => {
  it("cuts the filing's 3,000 pages into 12 ranges of 250, every page in exactly one", () => {
    const ranges = pageRanges(3000, 250);
    expect(ranges, "the filing makes 12 ranges").toHaveLength(12);
    expect(
      [span(ranges[0]), span(ranges[1]), span(ranges[9]), span(ranges[11])],
      "ranges are inclusive: 1 to 250 is 250 pages, so a range ends at from + size - 1",
    ).toEqual(["1-250", "251-500", "2251-2500", "2751-3000"]);
    const pages = ranges.flatMap((range) =>
      Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i),
    );
    expect(pages, "a range ends at from + size - 1, and the next starts on the page after").toEqual(
      Array.from({ length: 3000 }, (_, i) => i + 1),
    );
  });

  it("clips the last range at the last page", () => {
    expect(pageRanges(7, 2).map(span)).toEqual(["1-2", "3-4", "5-6", "7-7"]);
    expect(pageRanges(501, 250).map(span)).toEqual(["1-250", "251-500", "501-501"]);
    expect(pageRanges(250, 250).map(span)).toEqual(["1-250"]);
  });
});

describe("fan-out", () => {
  /** A child that takes a moment, and reports how many children ran at once. */
  function children(fail: number | null = null) {
    const started: number[] = [];
    const finished: number[] = [];
    /** For each child, how many children had finished when it started. */
    const after = new Map<number, number>();
    let running = 0;
    let most = 0;
    const child = async (range: PageRange, index: number): Promise<RangeResult> => {
      started.push(index);
      after.set(index, finished.length);
      most = Math.max(most, ++running);
      await new Promise((resolve) => setTimeout(resolve, 10 + (index % 3) * 5));
      running--;
      finished.push(index);
      return index === fail
        ? { status: "failed", error: `pages ${span(range)} wouldn't parse` }
        : { status: "completed", chunks: range.to - range.from + 1 };
    };
    return { child, started, after, most: () => most };
  }

  it("runs at most `batch` children at once, and starts a batch only when the one before has finished", async () => {
    const { child, after, most } = children();
    const total = await fanOut(pageRanges(3000, 250), 10, child);
    expect(most(), "ten at a time: start a batch, wait for all of it, then the next").toBe(10);
    expect(
      [after.get(0), after.get(9), after.get(10), after.get(11)],
      "the second batch (ranges 10 and 11) starts once all ten of the first have finished",
    ).toEqual([0, 0, 10, 10]);
    expect(total, "the total is every child's chunks added up").toBe(3000);
  });

  it("gives each child its range's own index, which numbers its chunks", async () => {
    const seen: string[] = [];
    await fanOut(pageRanges(3000, 250), 10, async (range, index) => {
      seen.push(`${index}:${span(range)}`);
      return { status: "completed", chunks: 0 };
    });
    expect(
      seen.sort((a, b) => Number(a.split(":")[0]) - Number(b.split(":")[0])),
      "index in `ranges`, not in the batch",
    ).toEqual(pageRanges(3000, 250).map((range, i) => `${i}:${span(range)}`));
  });

  it("stops at the first batch that holds a failed range, before starting the next", async () => {
    const { child, started } = children(3);
    await expect(fanOut(pageRanges(3000, 250), 10, child)).rejects.toThrow("pages 751-1000 wouldn't parse");
    expect(
      started.sort((a, b) => a - b),
      "ranges 10 and 11 should never start",
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
