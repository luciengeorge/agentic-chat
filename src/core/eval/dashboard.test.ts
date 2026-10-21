// @vitest-environment node
import { describe, expect, it } from "vitest";

import { evalDashboard, readGoldenRuns } from "./dashboard";

describe("the eval dashboard's data", () => {
  it("reads every golden-set report, oldest first, with the M1 baseline in it", () => {
    const runs = readGoldenRuns();
    const baseline = runs.find((r) => r.file === "2026-10-13-full.json")!;
    expect(baseline).toMatchObject({
      mode: "full",
      questions: 46,
      recallAt10: 1,
      gatesPassed: true,
      answers: { passed: 40, total: 40 },
    });
    expect(baseline.mrr).toBeCloseTo(0.931, 3);
    expect(baseline.costUsd).toBeCloseTo(0.0167, 4);
    const dates = runs.map((r) => r.date);
    expect(dates.every((date, i) => i === 0 || dates[i - 1] <= date)).toBe(true);
    expect(runs.find((r) => r.mode === "retrieval-only-hyde")!.answers).toBeNull();
  });

  it("puts the golden runs, the judge's calibration and the agent tasks together, from recordings", async () => {
    const dashboard = await evalDashboard();
    expect(dashboard.golden.length).toBeGreaterThanOrEqual(4);
    expect(dashboard.faithfulness!.summary.judge.kappa).toBeCloseTo(0.894, 3);
    expect(dashboard.faithfulness!.results).toHaveLength(20);
    expect(dashboard.agentTasks.passed).toBe(4);
  });
});
