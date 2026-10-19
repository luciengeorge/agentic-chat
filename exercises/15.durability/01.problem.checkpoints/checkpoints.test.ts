// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";
import type { AgentRuntime } from "@/lib/agent-runtime";

import { advance } from "#learn/agent/checkpoint";
import { RunHalted } from "#learn/agent/loop";
import { claim, type Job, reclaimExpired } from "#learn/queue/queue";
import { workOnce } from "#learn/queue/worker";
import {
  durableWorld,
  failingModel,
  GRACE_MESSAGE,
  graceRuntime,
  hangingModel,
  Mailroom,
} from "@/core/agent/durable-testing";
import { replayAgentModel } from "@/core/agent/loop-recorded";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";
import { AGENT_QUEUE, type AgentJob, agentJobHandler, enqueueStep } from "@/lib/agent-queue";
import {
  abortLive,
  cancelRun,
  decideApproval,
  loadRun,
  loadState,
  runStore,
  startRun,
  stepLoop,
} from "@/lib/agent-runs";

const SEND_CALL = "call_4NmkEZ5nioB2ceFw1vL09fLI";
const DAY_MS = 24 * 60 * 60 * 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Fails with `why` instead of hanging until the test times out. */
const within = <T>(ms: number, promise: Promise<T>, why: string) =>
  Promise.race([promise, sleep(ms).then(() => Promise.reject(new Error(why)))]);

/** The runtime, with each tool call's name written down as the runner runs it. */
const watched = (runtime: AgentRuntime, ran: string[]): AgentRuntime => ({
  ...runtime,
  loop: (viewer) => {
    const loop = runtime.loop(viewer);
    return { ...loop, runTools: (calls, ctx) => (ran.push(...calls.map((c) => c.tool)), loop.runTools(calls, ctx)) };
  },
});

describe.skipIf(!postgresAvailable)("checkpoints on the job queue", () => {
  let t: TestDatabase;
  let grace: Viewer;

  const state = async (runId: string) =>
    (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadState(tx, grace, runId)))!;
  const describeLog = async (runId: string) =>
    (await state(runId)).events.map((e) =>
      e.data.type === "status" ? `status ${e.data.from}->${e.data.to}` : e.data.type,
    );
  const stepKeys = async (runId: string) =>
    (
      await t.sql<{ step_key: string | null }[]>`
      SELECT step_key FROM run_events WHERE run_id = ${runId} ORDER BY seq`
    ).map((r) => r.step_key);
  const begin = async () => {
    const runId = crypto.randomUUID();
    await startRun(t.appDb, grace, { runId, message: { messageId: "m1", text: GRACE_MESSAGE } });
    return runId;
  };
  /** The run's log and loop, as a checkpoint sees them. */
  const pieces = async (runtime: AgentRuntime, runId: string) => {
    const run = (await withTenantOn(t.appDb, grace.tenantId, (tx) => loadRun(tx, grace, runId)))!;
    return {
      store: runStore(t.appDb, grace, runId, { approvalTtlMs: runtime.approvalTtlMs }),
      loop: stepLoop(runtime.loop(grace), grace, run),
    };
  };
  const checkpoint = async (runtime: AgentRuntime, runId: string, stepKey: string) => {
    const { store, loop } = await pieces(runtime, runId);
    return advance(store, loop, { stepKey, signal: new AbortController().signal });
  };
  /** The queue as the dev server runs it, with the job's handler bound to `runtime`. */
  const queue = (runtime: AgentRuntime) => {
    const handler = agentJobHandler(() => runtime);
    const options = { db: t.db, queue: AGENT_QUEUE, handler, retryInMs: () => 0 };
    return {
      handler,
      /** Works every due job; how many it worked. */
      async drain() {
        let jobs = 0;
        while (await workOnce<AgentJob>(options)) {
          if (++jobs > 40) throw new Error("40 jobs and the run still isn't settled: does every job queue another?");
        }
        return jobs;
      },
    };
  };
  const enqueue = (runId: string) => withTenantOn(t.appDb, grace.tenantId, (tx) => enqueueStep(tx, grace, runId));
  const approvalOf = async (runId: string) =>
    (await state(runId)).events.flatMap((e) => (e.data.type === "approval_requested" ? [e.data] : []))[0]!;
  /** Claims the run's next job as a worker would, with a short lease. */
  const claimed = async (leaseMs = 150) => (await claim<AgentJob>(t.db, AGENT_QUEUE, "worker-a", leaseMs))!;
  const settle = <T>(promise: Promise<T>) =>
    promise.then(
      (value) => ({ threw: false as const, value }),
      (error: unknown) => ({ threw: true as const, error }),
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    ({ grace } = await durableWorld(t.sql));
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    // Each test's queue holds its own run's jobs only.
    await t.sql`DELETE FROM jobs`;
  });

  describe("advance: one checkpoint", () => {
    it("claims a fresh run and makes one model turn, appended under the step's key", async () => {
      const replay = replayAgentModel("kpc-terms");
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: replay.model });
      const runId = await begin();
      expect(await checkpoint(runtime, runId, "job:a")).toEqual({ kind: "continue" });
      expect(
        replay.requests,
        "one checkpoint is one piece of work: plan, then a single model turn, tool batch or approval",
      ).toHaveLength(1);
      expect(await describeLog(runId)).toEqual(["user_message", "status queued->running", "assistant_turn"]);
      expect(await stepKeys(runId), "the turn is written under the step's key, `<stepKey>:0`").toEqual([
        null,
        null,
        "job:a:0",
      ]);
    });

    it("does nothing when the same key runs again: no model call, no tool", async () => {
      const replay = replayAgentModel("kpc-terms");
      const ran: string[] = [];
      const runtime = watched(graceRuntime(t.appDb, { mailroom: new Mailroom(), model: replay.model }), ran);
      const runId = await begin();
      await checkpoint(runtime, runId, "job:a");
      expect(await checkpoint(runtime, runId, "job:a")).toEqual({ kind: "continue" });
      expect(replay.requests, "a second model turn for a step that already wrote its turn").toHaveLength(1);
      expect(
        ran,
        "the step `job:a` already wrote (its turn is in the log), so plan has moved on to the tools; a step whose key " +
          "already wrote must not do them. Check `store.wrote(stepKey)` before running the tools",
      ).toEqual([]);
      expect(await describeLog(runId)).toHaveLength(3);

      expect(await checkpoint(runtime, runId, "job:b")).toEqual({ kind: "continue" });
      expect(ran, "the next step runs the turn's call").toEqual(["make_plan"]);
      expect((await describeLog(runId)).at(-1)).toBe("tool_result");
      expect((await stepKeys(runId)).at(-1)).toBe("job:b:0");
    });

    it("stops at Grace's send: the eighth checkpoint asks for her approval and answers waiting, due in 7 days", async () => {
      const ran: string[] = [];
      const runtime = watched(graceRuntime(t.appDb, { mailroom: new Mailroom() }), ran);
      const runId = await begin();
      const outcomes = [];
      for (let i = 1; i <= 8; i++) outcomes.push(await checkpoint(runtime, runId, `job:${i}`));
      expect(outcomes.slice(0, 7).every((o) => o.kind === "continue")).toBe(true);
      const last = outcomes[7];
      expect(last.kind, "the checkpoint that records the approval request returns `waiting`, with the approval").toBe(
        "waiting",
      );
      const approval = await approvalOf(runId);
      expect(last).toEqual({
        kind: "waiting",
        approval: { approvalId: approval.approvalId, callId: SEND_CALL, expiresAt: approval.expiresAt },
      });
      const asked = Date.parse((await state(runId)).events.at(-1)!.at);
      expect(Date.parse(approval.expiresAt) - asked).toBeGreaterThan(7 * DAY_MS - 5_000);
      expect(ran, "nothing is sent before Grace approves").toEqual([
        "make_plan",
        "search_documents",
        "find_person",
        "read_document",
      ]);
      expect((await state(runId)).run.status).toBe("waiting");
    });

    it("fails the run when the kill switch halts it, with the reason", async () => {
      const halt: Parameters<typeof graceRuntime>[1]["guard"] = {
        beforeModelTurn: async () => {
          throw new RunHalted("the agent kill switch is on");
        },
        afterModelTurn: async () => {},
        beforeToolCall: async () => {},
      };
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), guard: halt });
      const runId = await begin();
      const outcome = await settle(checkpoint(runtime, runId, "job:a"));
      expect(outcome.threw, "a RunHalted is caught: the run fails with its reason, and nothing retries").toBe(false);
      expect(outcome.threw ? null : outcome.value).toEqual({ kind: "final", status: "failed" });
      const last = (await state(runId)).events.at(-1)!.data;
      expect(last).toMatchObject({ type: "status", to: "failed", reason: "the agent kill switch is on" });
    });

    it("throws a 503 on to the caller, and leaves the log as it was", async () => {
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: failingModel(503) });
      const runId = await begin();
      const outcome = await settle(checkpoint(runtime, runId, "job:a"));
      expect(outcome.threw, "a 503 may pass on the next try: advance throws it on and the caller decides").toBe(true);
      expect(await describeLog(runId), "nothing is written for a turn that failed").toEqual([
        "user_message",
        "status queued->running",
      ]);
    });
  });

  describe("checkpointJob: one job on the queue", () => {
    it("drives Grace's run to her approval in 8 jobs, and queues the approval's expiry for its due time", async () => {
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom() });
      const runId = await begin();
      await enqueue(runId);
      expect(await queue(runtime).drain(), "each job is one checkpoint, and queues the next until the run waits").toBe(
        8,
      );
      expect((await state(runId)).run.status).toBe("waiting");
      const { approvalId, expiresAt } = await approvalOf(runId);
      const [expiry] = await t.sql<{ run_at: string; state: string; key: string }[]>`
        SELECT run_at, state, key FROM jobs WHERE payload->>'approvalId' = ${approvalId}`;
      expect(expiry, "a waiting run's job queues its approval's expiry (`deps.queueExpiry`)").toBeDefined();
      expect(expiry.state).toBe("queued");
      expect(Math.abs(new Date(expiry.run_at).getTime() - Date.parse(expiresAt))).toBeLessThan(5_000);
    });

    it("does nothing twice when a job comes back after it did its work: its step key is the job's id", async () => {
      const ran: string[] = [];
      const runtime = watched(graceRuntime(t.appDb, { mailroom: new Mailroom() }), ran);
      const runId = await begin();
      await enqueue(runId);
      const { handler } = queue(runtime);
      const job = await claimed();
      await handler(job, new AbortController().signal);
      const after = await describeLog(runId);
      // The worker died before it marked the job done: the lease runs out and the job comes back, one attempt on.
      const again: Job<AgentJob> = { ...job, attempts: job.attempts + 1 };
      await handler(again, new AbortController().signal);
      expect(
        ran,
        "the redone job did new work. A job that comes back has the same id, so the same step key: `job:<job.id>`, " +
          "with no attempt number or random part, finds its own turn in the log and stops",
      ).toEqual([]);
      expect(await describeLog(runId)).toEqual(after);
    });

    it("throws when the worker loses its lease, so the job comes back, and leaves the run running", async () => {
      const hang = hangingModel(0);
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: hang.model });
      const runId = await begin();
      await enqueue(runId);
      const worker = new AbortController();
      const job = await claimed();
      const working = settle(queue(runtime).handler(job, worker.signal));
      await expect.poll(() => hang.calls()).toBe(1);
      worker.abort(new Error("lease lost"));
      const outcome = await working;
      expect(outcome.threw, "the worker was told to stop: throw, so the queue takes the job back").toBe(true);
      expect(
        (await state(runId)).run.status,
        "a lost lease isn't the run's failure: the job comes back and finishes it",
      ).toBe("running");
    });

    it("throws a 503 back while the job has attempts left, and fails the run on its last", async () => {
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: failingModel(503) });
      const runId = await begin();
      await enqueue(runId);
      const job = await claimed();
      const first = await settle(queue(runtime).handler(job, new AbortController().signal));
      expect(first.threw, "a 503 with attempts left goes back to the queue, which backs off and retries").toBe(true);
      expect((await state(runId)).run.status).toBe("running");

      const last = await settle(
        queue(runtime).handler({ ...job, attempts: job.maxAttempts }, new AbortController().signal),
      );
      expect(last.threw, "on the last attempt, fail the run: a dead job leaves nothing to finish it").toBe(false);
      const s = await state(runId);
      expect(s.run.status).toBe("failed");
      expect(s.events.at(-2)!.data).toMatchObject({ type: "error", message: "HTTP 503", retryable: false });
    });

    it("fails the run at once on a 400: retrying sends the same bad request", async () => {
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: failingModel(400) });
      const runId = await begin();
      await enqueue(runId);
      const outcome = await settle(queue(runtime).handler(await claimed(), new AbortController().signal));
      expect(outcome.threw, "a 400 won't pass on a retry: fail the run instead of throwing").toBe(false);
      expect((await state(runId)).run.status).toBe("failed");
    });

    it("ends quietly when the user cancels mid-turn: no throw, and the run stays cancelled", async () => {
      const hang = hangingModel(0);
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: hang.model });
      const runId = await begin();
      await enqueue(runId);
      const working = settle(queue(runtime).handler(await claimed(), new AbortController().signal));
      await expect.poll(() => hang.calls()).toBe(1);
      expect(await cancelRun(t.appDb, grace, runId, async (_, id) => void abortLive(id))).toBe("ok");
      const outcome = await within(
        3_000,
        working,
        "the model call is still running after the cancel: advance's signal must abort on the cancel switch " +
          "(`deps.hold(runId).signal`) as well as the worker's",
      );
      expect(
        outcome.threw,
        "the user's cancel aborted the turn: the run is final, so return. Wire `deps.hold`'s signal into advance, " +
          "and check it before the worker's",
      ).toBe(false);
      expect(hang.aborted(), "the cancel reaches the model call through advance's signal").toBe(true);
      expect((await state(runId)).run.status).toBe("cancelled");
    });

    it("checks the cancel before the lease: when both abort at once, the job ends quietly and the run stays cancelled", async () => {
      const hang = hangingModel(0);
      const runtime = graceRuntime(t.appDb, { mailroom: new Mailroom(), model: hang.model });
      const runId = await begin();
      await enqueue(runId);
      const worker = new AbortController();
      const working = settle(queue(runtime).handler(await claimed(), worker.signal));
      await expect.poll(() => hang.calls()).toBe(1);
      // The server shuts down as Grace cancels: the cancel switch and the worker's signal abort together.
      const both = async (_: unknown, id: string) => {
        abortLive(id);
        worker.abort(new Error("shutting down"));
      };
      expect(await cancelRun(t.appDb, grace, runId, both)).toBe("ok");
      const outcome = await within(3_000, working, "the model call is still running after the cancel");
      expect(
        outcome.threw,
        "both signals aborted and the job threw, which hands it back to the queue for a run that's already " +
          "cancelled. The order of the checks matters: the cancel switch (`deps.hold`'s signal) first, then the " +
          "worker's `signal`",
      ).toBe(false);
      expect((await state(runId)).run.status).toBe("cancelled");
    });

    it("expires an approval nobody decided, from its own job, and the run carries on without the mail", async () => {
      const mailroom = new Mailroom();
      const runtime = graceRuntime(t.appDb, { mailroom, approvalTtlMs: 100 });
      const runId = await begin();
      await enqueue(runId);
      const q = queue(runtime);
      await q.drain();
      expect((await state(runId)).run.status).toBe("waiting");
      await sleep(150);
      await q.drain();
      const s = await state(runId);
      expect(
        s.events.map((e) => e.data),
        "the expiry job settles the approval as expired, then queues the run's next step",
      ).toContainEqual(expect.objectContaining({ type: "approval_decided", decision: "expired", by: null }));
      expect(s.run.status).toBe("succeeded");
      expect(mailroom.attempts).toEqual([]);
    });

    it("finishes Grace's run after a worker is killed mid-send: the job comes back, and Tom gets one mail", async () => {
      const mailroom = new Mailroom();
      const runtime = graceRuntime(t.appDb, { mailroom, hangSends: 1 });
      const runId = await begin();
      await enqueue(runId);
      const q = queue(runtime);
      expect(await q.drain()).toBe(8);
      const { approvalId } = await approvalOf(runId);
      expect(
        await decideApproval(t.appDb, grace, approvalId, "approved", async () => void (await enqueue(runId))),
      ).toBe("ok");

      // A worker takes the send with a 150 ms lease, and is killed while the mail is in flight.
      const job = await claimed(150);
      const killed = new AbortController();
      const dying = settle(q.handler(job, killed.signal));
      await expect.poll(() => mailroom.attempts.length).toBe(1);
      killed.abort(new Error("SIGKILL"));
      expect((await dying).threw).toBe(true);
      expect((await state(runId)).run.status).toBe("running");

      await sleep(200);
      expect(
        await reclaimExpired(t.db, AGENT_QUEUE),
        "the dead worker's lease ran out: its job is queued again",
      ).toEqual({ requeued: 1, dead: 0 });
      expect(await q.drain(), "the send again, the answer, the finish").toBe(3);
      const s = await state(runId);
      expect(s.run.status).toBe("succeeded");
      expect([s.events.length, s.run.version]).toEqual([17, 15]);
      expect(s.events.filter((e) => e.data.type === "tool_result" && e.data.callId === SEND_CALL)).toHaveLength(1);
      const key = `agent:${runId}:${SEND_CALL}`;
      expect(mailroom.attempts, "the send went out twice, under one key").toEqual([key, key]);
      expect(mailroom.mails, "and fake-workspace keeps one mail per key").toEqual([key]);
    });
  });
});
