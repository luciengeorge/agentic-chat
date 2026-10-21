// @vitest-environment node
import { describe, expect, it } from "vitest";

import { mean, ndcgAtK, recallAtK, reciprocalRank } from "#learn/eval/metrics";
import { readGoldenReport } from "@/core/eval/golden-report";

describe("recall@k", () => {
  it("is the share of the labels found in the top k, whatever their order", () => {
    expect(recallAtK([null, 0, null, 1], 2, 10)).toBe(1);
    expect(recallAtK([1, 0, null, null], 2, 10), "the same two labels in another order: the same recall").toBe(1);
    expect(recallAtK([null, 0, null, 1], 2, 3), "one of two labels in the top 3").toBe(0.5);
    expect(recallAtK([null, null], 3, 10)).toBe(0);
  });

  it("divides by the labels, not by k", () => {
    expect(
      recallAtK([0, 1, 2, null, null, null, null, null, null, null], 3, 10),
      "3 of 3 labels found: 1. Dividing by k (3/10) is precision, another metric",
    ).toBe(1);
  });

  it("needs at least one label", () => {
    expect(() => recallAtK([], 0, 10), "a question with no labels has no recall: throw a RangeError").toThrow(
      RangeError,
    );
    expect(() => recallAtK([null], 1.5, 10)).toThrow(RangeError);
  });
});

describe("reciprocal rank", () => {
  it("is 1 over the rank of the first chunk that found a label, counting ranks from 1", () => {
    expect(reciprocalRank([0]), "a label at the top is rank 1, worth 1").toBe(1);
    expect(reciprocalRank([null, null, 1, 0])).toBeCloseTo(1 / 3);
  });

  it("is 0 when nothing was found", () => {
    expect(reciprocalRank([null, null])).toBe(0);
    expect(reciprocalRank([])).toBe(0);
  });
});

describe("NDCG@k", () => {
  it("is 1 for a perfect ranking and 0 for nothing found", () => {
    expect(ndcgAtK([0, 1, null], 2, 10)).toBe(1);
    expect(ndcgAtK([null, null], 1, 10)).toBe(0);
  });

  it("discounts a label at rank r by log2(r + 1), against the ideal ranking", () => {
    expect(ndcgAtK([null, null, 0], 1, 10), "one label at rank 3: (1 / log2(4)) / (1 / log2(2)) = 0.5").toBeCloseTo(
      0.5,
    );
    expect(ndcgAtK([0, null, 1], 2, 10), "ranks 1 and 3: (1 + 0.5) / (1 + 1/log2(3))").toBeCloseTo(
      1.5 / (1 + 1 / Math.log2(3)),
    );
  });

  it("ignores hits below k, and never fills the ideal past k", () => {
    expect(ndcgAtK([null, 0], 1, 1), "the hit is at rank 2, outside the top 1").toBe(0);
    expect(
      ndcgAtK([0], 3, 1),
      "3 labels, k = 1: the best possible is one label at rank 1, so this ranking is perfect",
    ).toBe(1);
  });

  it("needs at least one label", () => {
    expect(() => ndcgAtK([], 0, 10)).toThrow(RangeError);
  });
});

describe("the golden set's 14 October run, scored again", () => {
  const report = readGoldenReport();
  const answered = report.questions.filter((q) => q.labels.length > 0);
  const judged = (q: (typeof answered)[number]) => q.ranked.map((c) => c.label);

  it("scores Daniel Reyes's Heron question, labels at ranks 2, 5 and 6", () => {
    const heron = answered.find((q) => q.id === "heron-cfo")!;
    expect([recallAtK(judged(heron), 3, 3), recallAtK(judged(heron), 3, 5), recallAtK(judged(heron), 3, 10)]).toEqual([
      1 / 3,
      2 / 3,
      1,
    ]);
    expect(reciprocalRank(judged(heron))).toBe(0.5);
    expect(ndcgAtK(judged(heron), 3, 10), "1.374 over the ideal 2.131").toBeCloseTo(0.6448, 4);
  });

  it("gives every question the scores the run gave it, and the run its recall@10 1.000, MRR 0.931, NDCG@10 0.938", () => {
    const scores = answered.map((q) => ({
      id: q.id,
      recallAt10: recallAtK(judged(q), q.labels.length, 10),
      reciprocalRank: reciprocalRank(judged(q)),
      ndcgAt10: ndcgAtK(judged(q), q.labels.length, 10),
    }));
    const differ = scores
      .filter((s, i) => {
        const r = answered[i].scores!;
        return (
          Math.abs(s.recallAt10 - r.recallAt10) > 1e-9 ||
          Math.abs(s.reciprocalRank - r.reciprocalRank) > 1e-9 ||
          Math.abs(s.ndcgAt10 - r.ndcgAt10) > 1e-9
        );
      })
      .map((s) => s.id);
    expect(differ, "these questions scored differently from the run").toEqual([]);
    expect(mean(scores.map((s) => s.recallAt10))).toBe(1);
    expect(mean(scores.map((s) => s.reciprocalRank)), "35 at rank 1, four at rank 2, one at rank 4: 37.25 / 40").toBe(
      0.93125,
    );
    expect(mean(scores.map((s) => s.ndcgAt10))).toBeCloseTo(0.938, 3);
    expect(report.summary).toMatchObject({ questions: 40, recallAt10: 1, mrr: 0.93125 });
  });
});
