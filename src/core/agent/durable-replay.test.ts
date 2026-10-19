// @vitest-environment node
import { describe, expect, it } from "vitest";

import { newRunLog, replay } from "#learn/agent/durable-replay";
import { Crash, graceBody, graceWorld } from "@/core/agent/durable-testing";

describe("replay (section 15.6's replayer)", () => {
  it("runs Grace's run once, replays it without running anything, and resumes it after a crash", async () => {
    const world = graceWorld();
    const log = newRunLog();
    expect(await replay((run) => graceBody(run, world), log)).toMatchObject({ kind: "done", value: "succeeded" });
    expect(log.steps).toHaveLength(28);
    expect((await replay((run) => graceBody(run, world), log)).ran).toEqual([]);

    const crashed = graceWorld();
    const cut = newRunLog();
    crashed.crashAfter(14);
    await expect(replay((run) => graceBody(run, crashed), cut)).rejects.toBeInstanceOf(Crash);
    expect(await replay((run) => graceBody(run, crashed), cut)).toMatchObject({ kind: "done" });
    expect([crashed.sends.length, crashed.mails.length]).toEqual([2, 1]);
  });

  it("diverges when the body asks for another step than the log holds", async () => {
    const log = newRunLog();
    await replay(async (run) => run.step("wait", [], async () => 1), log);
    const result = await replay(async (run) => run.step("remind", [], async () => 1), log);
    expect(result).toMatchObject({ kind: "diverged", divergence: { index: 0, expected: "wait()", got: "remind()" } });
  });
});
