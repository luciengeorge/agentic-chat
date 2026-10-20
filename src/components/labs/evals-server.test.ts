// @vitest-environment node
import { describe, expect, it } from "vitest";

import * as metrics from "#learn/eval/metrics";

import { evalsLab, rescore } from "./evals-server";

describe("the eval dashboard lab", () => {
  it("rescores every golden run with the metrics and agrees with what each run recorded", async () => {
    const lab = await evalsLab();
    expect(lab.golden.length).toBeGreaterThanOrEqual(4);
    const baseline = lab.golden.find((r) => r.file === "2026-10-14-retrieval-only.json")!;
    expect(baseline.rescored).toMatchObject({ ok: true, value: { recallAt10: 1, mrr: 0.93125, differ: [] } });
    for (const run of lab.golden) expect(run.rescored, run.file).toMatchObject({ ok: true, value: { differ: [] } });
  });

  it("shows the judge's and the claims' calibration, and the four agent tasks", async () => {
    const lab = await evalsLab();
    expect(lab.faithfulness.ok && lab.faithfulness.value).toMatchObject({
      judge: { kappa: expect.closeTo(0.894, 3), words: "almost perfect", disagreements: ["heron-recorded"] },
      claims: { kappa: expect.closeTo(0.898, 3), disagreements: ["london-old-limit"] },
    });
    expect(lab.agentTasks).toMatchObject({ ok: true, value: { passed: 4, meanScore: 1 } });
  });

  it("names the step to finish when metrics.ts doesn't have a function yet, and passes a stub's error on", () => {
    const { recallAtK: _recall, ...step1 } = metrics;
    expect(() => rescore("2026-10-14-retrieval-only.json", step1)).toThrow(/step 18.2/);
    const stub = {
      ...metrics,
      judge: () => {
        throw new Error("judge(10 chunks, 3 labels) isn't written yet");
      },
    };
    expect(() => rescore("2026-10-14-retrieval-only.json", stub)).toThrow("isn't written yet");
  });
});
