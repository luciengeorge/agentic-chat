// @vitest-environment node
import { describe, expect, it } from "vitest";

import { calibrate, judgeFaithfulness, JUDGE_INSTRUCTIONS } from "#learn/eval/judge";
import { scriptedObjects } from "#learn/model/testing";

import { judgeItem, summarizeFaithfulness } from "./faithfulness";
import { loadJudgeSet } from "./judge-set";
import { evalRecording, recordedUsage, replayEvalModel } from "./recorded";

const set = loadJudgeSet();

describe("the hand-labelled faithfulness set", () => {
  it("has 20 items over the four recorded turns, 8 faithful and 12 not", () => {
    expect(set).toHaveLength(20);
    expect(new Set(set.map((i) => i.turn))).toEqual(new Set(["london-hotel", "heron", "brightwell", "invoice-hold"]));
    expect(set.filter((i) => i.label === "faithful")).toHaveLength(8);
  });

  it("gives each item the 8 sources the model saw, labelled S1 to S8, and the recorded reply where it says so", () => {
    const london = set.find((i) => i.id === "london-recorded")!;
    expect(london.sources.map((s) => s.label)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"]);
    expect(london.sources[2].text).toContain("| Hotel, London | £180 a night | £200 a night |");
    expect(london.answer).toContain("**£200 per night**");
    expect(set.find((i) => i.id === "heron-recorded")!.answer).toBe(
      "I couldn't find an answer to that in the documents you can access.",
    );
  });
});

describe("judgeFaithfulness", () => {
  it("sends the sources, question and answer, and returns the verdict with its reason", async () => {
    const { model, mock } = scriptedObjects([{ reason: "S3 says £200, not £220.", verdict: "unfaithful" }]);
    const item = set.find((i) => i.id === "london-wrong-number")!;
    const verdict = await judgeFaithfulness(model, item, "low");
    expect(verdict).toMatchObject({ verdict: "unfaithful", reason: "S3 says £200, not £220." });
    const call = mock.doGenerateCalls[0];
    const text = JSON.stringify(call.prompt);
    expect(JSON.stringify(call.prompt[0])).toContain("faithful to the sources");
    expect(text).toContain('<source id=\\"S3\\"');
    expect(text).toContain("£220 a night");
    expect(text).toContain(item.question);
  });

  it("says in its instructions that an incomplete answer can still be faithful", () => {
    expect(JUDGE_INSTRUCTIONS).toMatch(/leaves part of the question unanswered can still be faithful/);
  });

  it("throws when the reply doesn't match the schema", async () => {
    const { model } = scriptedObjects([{ verdict: "maybe", reason: "?" }]);
    await expect(judgeFaithfulness(model, set[0], "low")).rejects.toThrow();
  });
});

describe("calibrate", () => {
  it("lists the items where the judge and the hand label differ", () => {
    const c = calibrate([
      { id: "a", label: "faithful", verdict: "faithful" },
      { id: "b", label: "unfaithful", verdict: "faithful" },
      { id: "c", label: "unfaithful", verdict: "unfaithful" },
    ]);
    expect(c.disagreements).toEqual(["b"]);
    expect(c.confusion.counts.unfaithful.faithful).toBe(1);
    expect(c.observed).toBeCloseTo(2 / 3);
  });
});

describe("the recorded judge and claim calls", () => {
  it("replay to the numbers section 18 quotes", async () => {
    const results = [];
    for (const item of set)
      results.push(await judgeItem(item, { modelFor: replayEvalModel, reasoningEffort: "medium" }));
    const s = summarizeFaithfulness(results);

    // The judge: 19 of 20 against chance's 0.53. It called the Heron abstention unfaithful, mixing up "answers the
    // question" with "says only what the sources say".
    expect(s.judge.disagreements).toEqual(["heron-recorded"]);
    expect(s.judge.observed).toBe(0.95);
    expect(s.judge.chance).toBeCloseTo(0.53);
    expect(s.judge.kappa).toBeCloseTo(0.894, 3);

    // Claims: checked against what each claim cites, "the limit is £180" is supported by S1, the old policy. Only
    // S3 says version 2 replaced it, and the claim didn't cite S3.
    expect(s.claims.disagreements).toEqual(["london-old-limit"]);
    expect(s.claims.kappa).toBeCloseTo(0.898, 3);
    expect(s.claimsPerAnswer).toBeCloseTo(48 / 19);
    expect(s.meanFaithfulness.faithful).toBe(1);
    expect(s.meanFaithfulness.unfaithful).toBeCloseTo(0.549, 3);

    const arithmetic = results.find((r) => r.id === "invoice-arithmetic")!;
    expect(arithmetic.claims.filter((c) => c.verdict !== "supported").map((c) => c.text)).toEqual([
      expect.stringContaining("£800"),
    ]);
  });

  it("cost $0.0134 to record: 107,031 input and 6,751 output tokens on gpt-6-luna", () => {
    let input = 0;
    let output = 0;
    for (const name of ["judge", "claims"] as const) {
      for (const calls of Object.values(evalRecording(name)!.calls)) {
        for (const call of calls) {
          const u = recordedUsage(call);
          input += u.inputTokens;
          output += u.outputTokens;
        }
      }
    }
    expect([input, output]).toEqual([107031, 6751]);
  });
});
