import { describe, expect, it } from "vitest";

import { chanceAgreement, cohensKappa, confusionMatrix, describeKappa, observedAgreement } from "#learn/eval/kappa";

const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

describe("Cohen's kappa", () => {
  it("works the textbook example: 20 items, 15 agreements", () => {
    // Hand: 10 yes, 10 no. Judge: says yes on 8 of the yeses and 3 of the nos.
    const hand = [...repeat("yes", 10), ...repeat("no", 10)];
    const judge = [...repeat("yes", 8), ...repeat("no", 2), ...repeat("yes", 3), ...repeat("no", 7)];
    const m = confusionMatrix(hand, judge, ["yes", "no"]);
    expect(m.counts).toEqual({ yes: { yes: 8, no: 2 }, no: { yes: 3, no: 7 } });
    expect(observedAgreement(m)).toBe(0.75);
    // Hand says yes half the time, the judge 11 times in 20: 0.5 * 0.55 + 0.5 * 0.45.
    expect(chanceAgreement(m)).toBeCloseTo(0.5);
    expect(cohensKappa(m)).toBeCloseTo(0.5);
  });

  it("gives a judge that always says the common label 0, however high its raw agreement", () => {
    const hand = [...repeat("faithful", 18), ...repeat("unfaithful", 2)];
    const lazy = repeat("faithful", 20);
    const m = confusionMatrix(hand, lazy, ["faithful", "unfaithful"]);
    expect(observedAgreement(m)).toBe(0.9);
    expect(cohensKappa(m)).toBe(0);
    expect(describeKappa(0)).toBe("no better than chance");
  });

  it("is 1 for perfect agreement and below 0 for systematic disagreement", () => {
    expect(cohensKappa(confusionMatrix(["a", "b", "a"], ["a", "b", "a"]))).toBe(1);
    expect(cohensKappa(confusionMatrix(["a", "b", "a", "b"], ["b", "a", "b", "a"]))).toBe(-1);
  });

  it("is 1 when both raters used one category for everything and agree", () => {
    expect(cohensKappa(confusionMatrix(["a", "a"], ["a", "a"]))).toBe(1);
  });

  it("refuses raters who labelled different numbers of items, or a label outside the categories", () => {
    expect(() => confusionMatrix(["a"], ["a", "b"])).toThrow(/same/);
    expect(() => confusionMatrix([], [])).toThrow(/no items/);
    expect(() => confusionMatrix(["a"], ["c"], ["a", "b"])).toThrow(/isn't a category/);
  });

  it("names the Landis and Koch bands", () => {
    expect([-0.1, 0.1, 0.3, 0.5, 0.7, 0.9].map(describeKappa)).toEqual([
      "worse than chance",
      "slight",
      "fair",
      "moderate",
      "substantial",
      "almost perfect",
    ]);
  });
});
