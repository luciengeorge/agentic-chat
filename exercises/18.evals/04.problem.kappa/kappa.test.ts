// @vitest-environment node
import { describe, expect, it } from "vitest";

import { judgeItem, summarizeFaithfulness } from "#learn/eval/faithfulness";
import { calibrate, type Faithfulness, judgeFaithfulness } from "#learn/eval/judge";
import { chanceAgreement, cohensKappa, confusionMatrix, describeKappa, observedAgreement } from "#learn/eval/kappa";
import { loadJudgeSet } from "@/core/eval/judge-set";
import { replayEvalModel } from "@/core/eval/recorded";

const repeat = <T>(value: T, n: number): T[] => Array.from({ length: n }, () => value);

describe("observed agreement, chance agreement and kappa", () => {
  it("work the textbook example: 20 items, 15 agreements, chance 0.5, kappa 0.5", () => {
    // Hand: 10 yes, 10 no. Judge: yes on 8 of the yeses and 3 of the nos.
    const hand = [...repeat("yes", 10), ...repeat("no", 10)];
    const judge = [...repeat("yes", 8), ...repeat("no", 2), ...repeat("yes", 3), ...repeat("no", 7)];
    const m = confusionMatrix(hand, judge, ["yes", "no"]);
    expect(observedAgreement(m), "the diagonal, 8 + 7, over 20").toBe(0.75);
    expect(chanceAgreement(m), "hand says yes half the time, the judge 11 in 20: 0.5 × 0.55 + 0.5 × 0.45").toBeCloseTo(
      0.5,
    );
    expect(cohensKappa(m), "(0.75 - 0.5) / (1 - 0.5)").toBeCloseTo(0.5);
  });

  it("gives a judge that always says the common label 0, however high its raw agreement", () => {
    const m = confusionMatrix([...repeat("faithful", 18), ...repeat("unfaithful", 2)], repeat("faithful", 20), [
      "faithful",
      "unfaithful",
    ]);
    expect(observedAgreement(m)).toBe(0.9);
    expect(chanceAgreement(m), "0.9 × 1 + 0.1 × 0: luck alone agrees 90% of the time").toBeCloseTo(0.9);
    expect(cohensKappa(m), "90% raw agreement, no better than luck: kappa 0").toBeCloseTo(0, 10);
  });

  it("is 1 for perfect agreement and -1 for raters who always disagree", () => {
    expect(cohensKappa(confusionMatrix(["a", "b", "a"], ["a", "b", "a"]))).toBe(1);
    expect(cohensKappa(confusionMatrix(["a", "b", "a", "b"], ["b", "a", "b", "a"]))).toBe(-1);
  });

  it("is 1, never NaN, when both raters used one category for everything and agree", () => {
    const m = confusionMatrix(["a", "a"], ["a", "a"]);
    expect(chanceAgreement(m)).toBe(1);
    expect(cohensKappa(m), "chance is 1, so (1 - 1) / (1 - 1) is 0 / 0: say 1 when they agree").toBe(1);
  });

  it("uses each rater's own habits, in any number of categories", () => {
    // Hand: 2 a, 2 b, 2 c. Judge: 2 a, 3 b, 1 c. Agree on 4 of 6.
    const m = confusionMatrix(["a", "a", "b", "b", "c", "c"], ["a", "b", "b", "b", "c", "a"]);
    expect(observedAgreement(m)).toBeCloseTo(4 / 6);
    expect(
      chanceAgreement(m),
      "(2/6)(2/6) + (2/6)(3/6) + (2/6)(1/6): the first rater's row shares times the second's column shares",
    ).toBeCloseTo(12 / 36);
    expect(cohensKappa(m)).toBeCloseTo(0.5);
  });
});

describe("the judge, calibrated against the 20 hand labels", () => {
  const set = loadJudgeSet();

  async function verdicts(): Promise<Array<{ id: string; label: Faithfulness; verdict: Faithfulness }>> {
    const out = [];
    for (const item of set) {
      const { verdict } = await judgeFaithfulness(replayEvalModel("judge", item.id), item, "medium");
      out.push({ id: item.id, label: item.label, verdict });
    }
    return out;
  }

  it("agrees on 19 of 20 against a chance of 0.53: kappa 0.894, almost perfect", async () => {
    const c = calibrate(await verdicts());
    expect(c.confusion.counts).toEqual({
      faithful: { faithful: 7, unfaithful: 1 },
      unfaithful: { faithful: 0, unfaithful: 12 },
    });
    expect(c.observed).toBe(0.95);
    expect(c.chance, "hand says faithful 8 in 20, the judge 7: 0.4 × 0.35 + 0.6 × 0.65").toBeCloseTo(0.53, 10);
    expect(c.kappa, "0.42 / 0.47").toBeCloseTo(0.894, 3);
    expect(describeKappa(c.kappa)).toBe("almost perfect");
    expect(c.disagreements, "the judge called the honest Heron abstention unfaithful").toEqual(["heron-recorded"]);
  });

  it("gives a judge that says unfaithful to everything 0.6 raw agreement and a kappa of 0", () => {
    const c = calibrate(set.map((i) => ({ id: i.id, label: i.label, verdict: "unfaithful" as const })));
    expect(c.observed).toBe(0.6);
    expect(c.kappa).toBeCloseTo(0, 10);
  });

  it("scored 0.794 before heron-closest's label was fixed: calibration found the person's mistake too", async () => {
    const before = (await verdicts()).map((v) => (v.id === "heron-closest" ? { ...v, label: "faithful" as const } : v));
    const c = calibrate(before);
    expect(c.disagreements).toEqual(["heron-recorded", "heron-closest"]);
    expect(c.observed).toBe(0.9);
    expect(c.chance, "hand now says faithful 9 in 20: 0.45 × 0.35 + 0.55 × 0.65").toBeCloseTo(0.515, 10);
    expect(c.kappa).toBeCloseTo(0.794, 3);
  });

  it("puts the claims method at 0.898 beside the judge's 0.894", async () => {
    const results = [];
    for (const item of set)
      results.push(await judgeItem(item, { modelFor: replayEvalModel, reasoningEffort: "medium" }));
    const s = summarizeFaithfulness(results);
    expect(s.judge.kappa).toBeCloseTo(0.894, 3);
    expect(s.claims.chance).toBeCloseTo(0.51, 10);
    expect(s.claims.kappa).toBeCloseTo(0.898, 3);
    expect(s.claims.disagreements).toEqual(["london-old-limit"]);
  });
});
