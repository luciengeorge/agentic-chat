// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RunEventData } from "#learn/agent/types";

import { append, readEvents, RunNotFoundError, VersionConflictError } from "#learn/agent/events";
import { IllegalTransitionError } from "#learn/agent/state";
import { appendsOf, loadRecorded, recordedRun, stateWorld, type StateWorld } from "@/core/agent/state-testing";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

const KPC = recordedRun("kpc-email").run.id;
const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 };
const say = (text: string, messageId = crypto.randomUUID()): RunEventData => ({
  type: "user_message",
  messageId,
  text,
});
const approved: RunEventData = {
  type: "approval_decided",
  approvalId: "71fc5274-520c-4915-a879-ede8e0499b24",
  decision: "approved",
  by: recordedRun("kpc-email").run.userId,
};

/** What a promise threw, or null. */
const caught = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: unknown) => error,
  );
/** A database error, explained by the constraint it broke. */
function explained(error: unknown): unknown {
  const cause = (error as { cause?: { constraint_name?: string; message?: string } })?.cause;
  const hints: Record<string, string> = {
    run_events_pkey:
      "two events got the same seq. In one batch: number them max + 1, max + 2, ... in the batch's order. In a race: the loser numbered its events without winning the run; the UPDATE must say `WHERE ... AND version = <expected>`, and the INSERT take its rows from that UPDATE, in the same statement",
    run_events_run_id_step_key_key: "two events got the same step key: event i of the batch is `<stepKey>:<i>`",
  };
  const hint = cause?.constraint_name ? hints[cause.constraint_name] : undefined;
  return hint ? new Error(`${hint} (${cause?.message})`, { cause: error }) : error;
}

describe.skipIf(!postgresAvailable)("appending to a run's log", () => {
  let t: TestDatabase;
  let world: StateWorld;

  const inTenant = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenantOn(t.appDb, world.tenantId, fn).catch((error: unknown) => {
      throw explained(error);
    });
  const run = async (id: string) =>
    (
      await t.sql<{ status: string; version: number; finished_at: Date | null; active_ms: number }[]>`
        SELECT status, version, finished_at, active_ms FROM runs WHERE id = ${id}`
    )[0];
  const log = (id: string) =>
    t.sql<{ seq: number; type: string; step_key: string | null }[]>`
      SELECT seq, type, step_key FROM run_events WHERE run_id = ${id} ORDER BY seq`;
  /** A new run: Leo's email run's row, queued at version 0, with an empty log. */
  const fresh = async () => {
    const runId = crypto.randomUUID();
    await loadRecorded(t.sql, world, "kpc-email", { runId, eventsToo: false });
    return runId;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    world = await stateWorld(t.sql);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("numbers a new run's first event 1, at version 1, and a batch of three as the next three, at version 2", async () => {
    const id = await fresh();
    const first = await inTenant((tx) => append(tx, id, 0, [say("Email Tom the payment terms")]));
    expect(
      first.events.map((e) => e.seq),
      "seq starts at 1 in an empty log",
    ).toEqual([1]);
    expect(first.version, "one append is one version").toBe(1);
    const second = await inTenant((tx) =>
      append(tx, id, 1, [
        { type: "status", from: "queued", to: "running" },
        { type: "assistant_turn", text: "", toolCalls: [], usage },
        { type: "status", from: "running", to: "succeeded" },
      ]),
    );
    expect(
      second.events.map((e) => e.seq),
      "a batch takes the next seqs in its own order",
    ).toEqual([2, 3, 4]);
    expect(second.version, "version counts appends, not events: three events, one more version").toBe(2);
    expect(second.events.map((e) => e.data.type)).toEqual(["status", "assistant_turn", "status"]);
    expect((await log(id)).map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("moves the run's status in the same write, and stamps finished_at when it's final", async () => {
    const id = await fresh();
    await inTenant((tx) => append(tx, id, 0, [say("hi"), { type: "status", from: "queued", to: "running" }]));
    expect(await run(id)).toMatchObject({ status: "running", version: 1, finished_at: null });
    const done = await inTenant((tx) =>
      append(tx, id, 1, [{ type: "status", from: "running", to: "succeeded" }], { activeMs: 1234.4 }),
    );
    expect(done.status).toBe("succeeded");
    const after = await run(id);
    expect(after.status, "the runs row's status is where the batch's moves leave it").toBe("succeeded");
    expect(after.finished_at, "a final status sets finished_at").not.toBeNull();
    expect(Number(after.active_ms), "active_ms adds the rounded activeMs").toBe(1234);
  });

  it("refuses an illegal move and writes nothing: not the move, not the events beside it", async () => {
    const id = await fresh();
    await inTenant((tx) => append(tx, id, 0, [say("hi")]));
    const error = await caught(
      inTenant((tx) => append(tx, id, 1, [say("one more"), { type: "status", from: "queued", to: "succeeded" }])),
    );
    expect(error, "queued -> succeeded: run the batch through applyStatus before writing").toBeInstanceOf(
      IllegalTransitionError,
    );
    expect((await log(id)).length, "the message beside the illegal move must not be written either").toBe(1);
    expect(await run(id)).toMatchObject({ status: "queued", version: 1 });
  });

  it("refuses a stale version with the version the run is really at, and writes nothing", async () => {
    const id = await fresh();
    await inTenant((tx) => append(tx, id, 0, [say("hi")]));
    const error = await caught(inTenant((tx) => append(tx, id, 0, [say("from a writer that read version 0")])));
    expect(error, "the run is at version 1, the writer read 0: throw a VersionConflictError").toBeInstanceOf(
      VersionConflictError,
    );
    expect(error).toMatchObject({ expected: 0, actual: 1 });
    expect((await log(id)).length, "a stale writer writes nothing (and never retries inside append)").toBe(1);
    expect((await run(id)).version).toBe(1);
  });

  it("names the step that wrote each event, `<stepKey>:<i>`, and leaves it null outside a step", async () => {
    const id = await fresh();
    await inTenant((tx) => append(tx, id, 0, [say("hi")]));
    await inTenant((tx) =>
      append(tx, id, 1, [{ type: "status", from: "queued", to: "running" }, say("two")], { stepKey: "wf:step_1" }),
    );
    expect((await log(id)).map((r) => r.step_key)).toEqual([null, "wf:step_1:0", "wf:step_1:1"]);
  });

  it("refuses a run that isn't there (or is another tenant's) with RunNotFoundError", async () => {
    const error = await caught(inTenant((tx) => append(tx, crypto.randomUUID(), 0, [say("hi")])));
    expect(error).toBeInstanceOf(RunNotFoundError);
  });

  it("lets one of eight writers at the same version through; the other seven conflict and write nothing", async () => {
    const id = await fresh();
    await inTenant((tx) => append(tx, id, 0, [say("hi")]));
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => caught(inTenant((tx) => append(tx, id, 1, [say(`writer ${i}`)])))),
    );
    const others = results.filter((r) => r !== null && !(r instanceof VersionConflictError));
    expect(others, others.length ? `expected VersionConflictErrors, got: ${String(others[0])}` : "").toEqual([]);
    expect(
      results.filter((r) => r === null),
      "exactly one writer at version 1 lands",
    ).toHaveLength(1);
    expect(
      (await log(id)).map((r) => r.seq),
      "the log grew by one event, with no gaps",
    ).toEqual([1, 2]);
    expect((await run(id)).version).toBe(2);
  });

  describe("the worked example: Leo's email run", () => {
    it("replays the recorded 17 events as their 15 appends: seq 1 to 17, version 15, succeeded", async () => {
      const recorded = recordedRun("kpc-email");
      const id = await fresh();
      const appends = appendsOf(recorded.events);
      expect(
        appends.map((a) => a.length).filter((n) => n > 1),
        "seq 6-7 and 11-12 were written together",
      ).toEqual([2, 2]);
      let version = 0;
      for (const batch of appends) {
        const written = await inTenant((tx) =>
          append(
            tx,
            id,
            version,
            batch.map((e) => e.data),
          ),
        );
        expect(written.events.map((e) => e.seq)).toEqual(batch.map((e) => e.seq));
        version = written.version;
      }
      expect(version, "17 events in 15 appends: version 15").toBe(15);
      expect(await run(id)).toMatchObject({ status: "succeeded", version: 15 });
      const back = await inTenant((tx) => readEvents(tx, id));
      expect(back.map((e) => e.data)).toEqual(recorded.events.map((e) => e.data));
    });

    it("races the approval and a follow-up at version 10: one lands at seq 13, the other is told the run moved on", async () => {
      const loaded = await loadRecorded(t.sql, world, "kpc-email", { throughSeq: 12 });
      expect(loaded).toMatchObject({ runId: KPC, version: 10, status: "waiting" });

      // Both read version 10. The approval's transaction holds the run's row; the follow-up waits on it.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let approvalWritten!: () => void;
      const approvalIn = new Promise<void>((resolve) => (approvalWritten = resolve));
      const approval = inTenant(async (tx) => {
        const written = await append(tx, KPC, 10, [approved]);
        approvalWritten();
        await held;
        return written;
      });
      await approvalIn;
      const followUp = caught(inTenant((tx) => append(tx, KPC, 10, [say("Copy Amara Okafor too.")])));
      const early = await Promise.race([
        followUp.then(() => "done"),
        new Promise((r) => setTimeout(r, 300, "waiting")),
      ]);
      expect(early, "the follow-up should wait on the approval's row lock: update the run in the same statement").toBe(
        "waiting",
      );
      release();
      expect((await approval).events.map((e) => e.seq)).toEqual([13]);
      const error = await followUp;
      expect(
        error,
        error instanceof VersionConflictError
          ? ""
          : error === null
            ? "both writers landed: the UPDATE must say WHERE version = <expected>, so the writer that waited updates nothing"
            : `expected a VersionConflictError, got: ${String(error)}`,
      ).toBeInstanceOf(VersionConflictError);
      expect(
        (await log(KPC)).map((r) => r.seq),
        "the follow-up wrote nothing",
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(await run(KPC)).toMatchObject({ version: 11, status: "waiting" });

      // A writer that read version 10 and comes back after the approval committed.
      const stale = await caught(inTenant((tx) => append(tx, KPC, 10, [say("Copy Amara Okafor too.")])));
      expect(stale).toBeInstanceOf(VersionConflictError);
      expect((stale as Error).message).toBe(`run ${KPC} is at version 11, not 10`);
    });
  });
});
