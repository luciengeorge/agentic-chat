import { waitForHook, waitForSleep } from "@workflow/vitest";
import { describe, expect, it } from "vitest";
import { getRun, resumeHook, start } from "workflow/api";

import { formatGreeting } from "#learn/_sample/greeting";
import { type SpikeEvent, spikeWorkflow } from "@/workflows/spike";

const HOUR = 60 * 60 * 1000;

describe("spikeWorkflow", () => {
  it("waits on its hook, sleeps, streams and completes, with no real waits", async () => {
    const token = "spike:test";
    const run = await start(spikeWorkflow, [token, HOUR]);

    await waitForHook(run, { token });
    expect(await run.status).toBe("running");
    await resumeHook(token, { note: "hi" });

    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    expect(await run.returnValue).toEqual({ greeting: formatGreeting("step"), note: "hi", chunks: 3 });
    const events: SpikeEvent[] = [];
    for await (const event of run.getReadable<SpikeEvent>()) events.push(event);
    expect(events.map((event) => event.text)).toEqual(["resumed", "hi", "done"]);
  });
});
