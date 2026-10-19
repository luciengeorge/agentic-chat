// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadRecorded, stateWorld, type StateWorld } from "@/core/agent/state-testing";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { cancelLabRun, listLabRuns, runLog, sendTwoAtOnce, startLabRun } from "./state-server";

describe.skipIf(!postgresAvailable)("the state lab", () => {
  let t: TestDatabase;
  let world: StateWorld;

  beforeAll(async () => {
    t = await createTestDatabase();
    world = await stateWorld(t.sql);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("shows a recorded run's log with each event's version: seq 6-7 and 11-12 were one append each", async () => {
    const { runId, viewer } = await loadRecorded(t.sql, world, "kpc-email");
    const log = await runLog(t.appDb, viewer, runId);
    expect(log.run).toMatchObject({ status: "succeeded", version: 15, lab: false });
    expect(log.events.map((e) => [e.seq, e.version])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
      [7, 6],
      [8, 7],
      [9, 8],
      [10, 9],
      [11, 10],
      [12, 10],
      [13, 11],
      [14, 12],
      [15, 13],
      [16, 14],
      [17, 15],
    ]);
    expect((await runLog(t.appDb, viewer, runId, 15)).events.map((e) => e.seq)).toEqual([16, 17]);
    expect((await runLog(t.appDb, world.viewerOf("cancel-waiting"), runId)).run, "only the viewer's runs").toBeNull();
    expect((await sendTwoAtOnce(t.appDb, viewer, runId)) as { error: string }).toMatchObject({
      error: expect.stringContaining("only a lab run"),
    });
  });

  it("starts a lab run, lands two messages sent at once in seq order, and stores the resend once", async () => {
    const leo = world.viewerOf("kpc-email");
    const { runId } = await startLabRun(t.appDb, leo);
    expect((await listLabRuns(t.appDb, leo)).find((r) => r.id === runId)).toMatchObject({
      status: "queued",
      version: 1,
      lab: true,
    });
    const sent = await sendTwoAtOnce(t.appDb, leo, runId);
    if ("error" in sent) throw new Error(sent.error);
    const [first, second, resend] = sent.sent;
    expect([first.result.kind, second.result.kind, resend.result.kind]).toEqual(["added", "added", "duplicate"]);
    const seqs = [first, second].map((s) => ("seq" in s.result ? s.result.seq : 0)).sort();
    expect(seqs).toEqual([2, 3]);
    expect("seq" in resend.result && resend.result.seq).toBe("seq" in first.result && first.result.seq);
    const log = await runLog(t.appDb, leo, runId);
    expect(log.events.map((e) => [e.seq, e.version])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);

    expect(await cancelLabRun(t.appDb, leo, runId)).toEqual({ result: "ok" });
    const after = await sendTwoAtOnce(t.appDb, leo, runId);
    expect("sent" in after && after.sent.map((s) => s.result.kind)).toEqual(["finished", "finished", "finished"]);
    expect((await runLog(t.appDb, leo, runId)).run).toMatchObject({ status: "cancelled", version: 4 });
  });
});
