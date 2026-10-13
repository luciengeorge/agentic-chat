import { describe, expect, it } from "vitest";

import { hitsLabel, judge, mean, ndcgAtK, recallAtK, reciprocalRank, type RankedChunk } from "./metrics";

const pdf = (page: number, pageEnd = page): RankedChunk => ({ path: "/a.pdf", pageStart: page, pageEnd });
const md: RankedChunk = { path: "/b.md", pageStart: null, pageEnd: null };
const other: RankedChunk = { path: "/c.pdf", pageStart: 1, pageEnd: 1 };

describe("hitsLabel", () => {
  it("matches a paged label when the chunk's pages include it", () => {
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(2))).toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(1, 3))).toBe(true);
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, pdf(3))).toBe(false);
    expect(hitsLabel({ path: "/a.pdf", page: 2 }, { ...pdf(2), path: "/z.pdf" })).toBe(false);
  });

  it("matches a pageless label with any chunk of its document, and a paged one never with a pageless chunk", () => {
    expect(hitsLabel({ path: "/b.md", page: null }, md)).toBe(true);
    expect(hitsLabel({ path: "/b.md", page: 1 }, md)).toBe(false);
  });
});

describe("judge", () => {
  it("credits each label once, to its highest chunk", () => {
    const labels = [
      { path: "/a.pdf", page: 2 },
      { path: "/b.md", page: null },
    ];
    expect(judge([other, pdf(2), pdf(2), md, pdf(1, 2)], labels)).toEqual([null, 0, null, 1, null]);
  });

  it("lets a chunk spanning two labelled pages find the second when the first is taken", () => {
    const labels = [
      { path: "/a.pdf", page: 2 },
      { path: "/a.pdf", page: 3 },
    ];
    expect(judge([pdf(2), pdf(2, 3)], labels)).toEqual([0, 1]);
  });
});

describe("recall@k", () => {
  it("is the share of labels found in the top k", () => {
    expect(recallAtK([null, 0, null, 1], 2, 10)).toBe(1);
    expect(recallAtK([null, 0, null, 1], 2, 3)).toBe(0.5);
    expect(recallAtK([null, null], 3, 10)).toBe(0);
  });

  it("needs a label", () => {
    expect(() => recallAtK([], 0, 10)).toThrow(RangeError);
  });
});

describe("reciprocal rank", () => {
  it("is 1 over the first hit's rank, or 0", () => {
    expect(reciprocalRank([0])).toBe(1);
    expect(reciprocalRank([null, null, 1])).toBeCloseTo(1 / 3);
    expect(reciprocalRank([null, null])).toBe(0);
    expect(reciprocalRank([])).toBe(0);
  });
});

describe("NDCG@k", () => {
  it("is 1 for a perfect ranking and 0 for none", () => {
    expect(ndcgAtK([0, 1, null], 2, 10)).toBe(1);
    expect(ndcgAtK([null, null], 1, 10)).toBe(0);
  });

  it("discounts by log2(rank + 1) against the ideal ranking", () => {
    // One label, found at rank 3: 1/log2(4) over 1/log2(2).
    expect(ndcgAtK([null, null, 0], 1, 10)).toBeCloseTo(0.5);
    // Two labels, found at ranks 1 and 3: (1 + 0.5) / (1 + 1/log2(3)).
    expect(ndcgAtK([0, null, 1], 2, 10)).toBeCloseTo(1.5 / (1 + 1 / Math.log2(3)));
  });

  it("ignores hits below k, and caps the ideal at k", () => {
    expect(ndcgAtK([null, 0], 1, 1)).toBe(0);
    expect(ndcgAtK([0], 3, 1)).toBe(1);
  });
});

describe("mean", () => {
  it("averages, and is NaN for nothing", () => {
    expect(mean([1, 0, 0.5])).toBe(0.5);
    expect(mean([])).toBeNaN();
  });
});
