// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { AgentContext } from "#learn/agent/context";
import type { AgentTool } from "#learn/agent/types";
import type { ChatModel } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

import { RunHalted } from "#learn/agent/loop";
import { addNote } from "#learn/agent/memory";
import { scriptedTurns } from "#learn/model/testing";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import {
  abortLive,
  addMessage,
  append,
  cancelRun,
  createRunnerLoop,
  decideApproval,
  driveRun,
  holdLive,
  listApprovals,
  IllegalTransitionError,
  loadState,
  type RunnerLoop,
  startRun,
  VersionConflictError,
} from "./agent-runs";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";
const NINA = "77777777-7777-4777-8777-777777777777";

/** Stand-ins for lane A's tools: the loop is real, the tools are scripted. */
function fakeTools(): AgentTool[] {
  const read = (name: string, execute: (input: unknown) => Promise<unknown>): AgentTool => ({
    name,
    description: name,
    input: z.object({}).passthrough(),
    effect: "read",
    needsApproval: () => false,
    execute,
  });
  return [
    read("search_documents", async (input) => ({ echo: input })),
    read("find_person", async (input) => ({ echo: input })),
    read("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return 1;
    }),
    read("boom", async () => {
      throw new Error("drive unavailable");
    }),
    {
      name: "send_mail",
      description: "send mail",
      input: z.object({ to: z.string() }),
      effect: "write",
      needsApproval: () => true,
      execute: async () => ({ sent: true }),
    },
  ];
}

describe.skipIf(!postgresAvailable)("the run service", () => {
  let t: TestDatabase;
  let kestrel: string;
  let harbour: string;
  let leo: Viewer;
  let nora: Viewer;
  let nina: Viewer;

  const state = (viewer: Viewer, runId: string) =>
    withTenantOn(t.appDb, viewer.tenantId, (tx) => loadState(tx, viewer, runId));
  const types = async (runId: string) => (await state(leo, runId))!.events.map((e) => e.data.type);
  const message = (text: string, messageId: string = crypto.randomUUID()) => ({ messageId, text });
  const newRun = async (viewer = leo, text = "hello") => {
    const runId = crypto.randomUUID();
    await startRun(t.appDb, viewer, { runId, message: message(text) });
    return runId;
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: kestrel }, { id: harbour }] = await t.sql`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id`;
    for (const [id, tenant, name] of [
      [LEO, kestrel, "leo.martin"],
      [NORA, kestrel, "nora.kim"],
      [NINA, harbour, "nina.osei"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    leo = { tenantId: kestrel, userId: LEO };
    nora = { tenantId: kestrel, userId: NORA };
    nina = { tenantId: harbour, userId: NINA };
  });

  afterAll(async () => {
    await t?.drop();
  });

  describe("append", () => {
    it("starts a run queued at version 1 with its message at seq 1", async () => {
      const runId = await newRun();
      const s = (await state(leo, runId))!;
      expect(s.run).toMatchObject({ status: "queued", version: 1, kind: "chat" });
      expect(s.events.map((e) => [e.seq, e.data.type])).toEqual([[1, "user_message"]]);
    });

    it("refuses a stale version and writes nothing", async () => {
      const runId = await newRun();
      const error = await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, runId, 0, [{ type: "status", from: "queued", to: "running" }]),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(VersionConflictError);
      expect(error).toMatchObject({ expected: 0, actual: 1 });
      expect(await types(runId)).toEqual(["user_message"]);
    });

    it("lets one of two writers at the same version through; the other conflicts", async () => {
      const runId = await newRun();
      const write = (text: string) =>
        withTenantOn(t.appDb, kestrel, (tx) =>
          append(tx, runId, 1, [{ type: "user_message", messageId: text, text }]),
        ).then(
          () => "ok",
          (error: unknown) => (error instanceof VersionConflictError ? "conflict" : error),
        );
      expect((await Promise.all([write("a"), write("b")])).sort()).toEqual(["conflict", "ok"]);
      const s = (await state(leo, runId))!;
      expect(s.run.version).toBe(2);
      expect(s.events.map((e) => e.seq)).toEqual([1, 2]);
    });

    it("moves the status through the state machine, and refuses an illegal move", async () => {
      const runId = await newRun();
      const appended = await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, runId, 1, [
          { type: "status", from: "queued", to: "running" },
          { type: "status", from: "running", to: "succeeded" },
        ]),
      );
      expect(appended).toMatchObject({ version: 2, status: "succeeded" });
      expect(appended.events.map((e) => e.seq)).toEqual([2, 3]);
      const s = (await state(leo, runId))!;
      expect(s.run.status).toBe("succeeded");
      expect(s.run.finishedAt).not.toBeNull();

      const again = await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, runId, 2, [{ type: "status", from: "succeeded", to: "running" }]),
      ).catch((caught: unknown) => caught);
      expect(again).toBeInstanceOf(IllegalTransitionError);

      const skip = await newRun();
      const skipped = await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, skip, 1, [{ type: "status", from: "queued", to: "succeeded" }]),
      ).catch((caught: unknown) => caught);
      expect(skipped).toBeInstanceOf(IllegalTransitionError);
    });

    it("writes a step's events once: a replayed step key is refused", async () => {
      const runId = await newRun();
      const write = (version: number) =>
        withTenantOn(t.appDb, kestrel, (tx) =>
          append(tx, runId, version, [{ type: "error", message: "x", retryable: true }], { stepKey: "step_1" }),
        );
      await write(1);
      expect(await write(2).catch((caught: unknown) => caught)).toMatchObject({
        cause: { code: "23505", constraint_name: "run_events_run_id_step_key_key" },
      });
    });
  });

  describe("messages", () => {
    it("stores a resent message once", async () => {
      const runId = await newRun();
      const m = message("are you there?");
      expect(await addMessage(t.appDb, leo, runId, m)).toMatchObject({ kind: "added", seq: 2 });
      expect(await addMessage(t.appDb, leo, runId, m)).toMatchObject({ kind: "duplicate", seq: 2 });
      const [first, second] = await Promise.all([
        addMessage(t.appDb, leo, runId, message("again", "same")),
        addMessage(t.appDb, leo, runId, message("again", "same")),
      ]);
      expect([first.kind, second.kind].sort()).toEqual(["added", "duplicate"]);
      expect(await types(runId)).toEqual(["user_message", "user_message", "user_message"]);
    });

    it("lands messages that arrive together, every one, in seq order", async () => {
      const runId = await newRun();
      const texts = Array.from({ length: 8 }, (_, i) => `message ${i}`);
      const results = await Promise.all(texts.map((text) => addMessage(t.appDb, leo, runId, message(text))));
      expect(results.every((r) => r.kind === "added")).toBe(true);
      const s = (await state(leo, runId))!;
      expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(s.run.version).toBe(9);
      const landed = s.events.slice(1).map((e) => (e.data.type === "user_message" ? e.data.text : ""));
      expect(landed.sort()).toEqual(texts);
      // Each got the seq it was told.
      for (const r of results) {
        if (r.kind !== "added") continue;
        expect(s.events.find((e) => e.seq === r.seq)!.data.type).toBe("user_message");
      }
    });

    it("refuses a message into a finished run", async () => {
      const runId = await newRun();
      await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, runId, 1, [{ type: "status", from: "queued", to: "cancelled" }]),
      );
      expect(await addMessage(t.appDb, leo, runId, message("late"))).toEqual({ kind: "finished", status: "cancelled" });
    });

    it("hides a run from another user and another tenant", async () => {
      const runId = await newRun();
      expect(await addMessage(t.appDb, nora, runId, message("hi"))).toEqual({ kind: "not-found" });
      expect(await addMessage(t.appDb, nina, runId, message("hi"))).toEqual({ kind: "not-found" });
      expect(await state(nora, runId)).toBeNull();
      expect(await state(nina, runId)).toBeNull();
      // A start with someone else's run id doesn't take it over.
      expect(await startRun(t.appDb, nora, { runId, message: message("mine now") })).toEqual({ kind: "not-found" });
    });
  });

  describe("the in-request runner", () => {
    const loop = (model: ChatModel, overrides: Partial<RunnerLoop> = {}): RunnerLoop & { contexts: AgentContext[] } => {
      const contexts: AgentContext[] = [];
      const real = createRunnerLoop(leo, { model, tools: fakeTools(), reasoningEffort: "medium" });
      return {
        ...real,
        contexts,
        modelTurn: (context, ctx) => {
          contexts.push(context);
          return real.modelTurn(context, ctx);
        },
        compact: async () => null,
        ...overrides,
      };
    };

    it("runs model, tools and model again, then succeeds, with the user's notes in the instructions", async () => {
      await withTenantOn(t.appDb, kestrel, (tx) => addNote(tx, leo, "Prefers answers in French.", null));
      const { model } = scriptedTurns([
        {
          toolCalls: [
            { callId: "c1", name: "search_documents", input: { query: "expenses" } },
            { callId: "c2", name: "find_person", input: { name: "Amara" } },
          ],
        },
        { text: "Voilà." },
      ]);
      const l = loop(model);
      const runId = await newRun(leo, "find the expenses policy");
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("succeeded");

      const s = (await state(leo, runId))!;
      expect(s.events.map((e) => (e.data.type === "status" ? `${e.data.from}->${e.data.to}` : e.data.type))).toEqual([
        "user_message",
        "queued->running",
        "assistant_turn",
        "tool_result",
        "tool_result",
        "assistant_turn",
        "running->succeeded",
      ]);
      expect(
        s.events.filter((e) => e.data.type === "tool_result").map((e) => (e.data as { callId: string }).callId),
      ).toEqual(["c1", "c2"]);
      expect(l.contexts[0].instructions).toContain("Prefers answers in French.");
      expect(l.contexts[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    });

    it("turns a thrown tool into a failed result, in call order", async () => {
      const { model } = scriptedTurns([
        {
          toolCalls: [
            { callId: "a", name: "slow", input: {} },
            { callId: "b", name: "boom", input: {} },
          ],
        },
        { text: "Done." },
      ]);
      const runId = await newRun();
      const l = loop(model);
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("succeeded");
      const results = (await state(leo, runId))!.events.flatMap((e) => (e.data.type === "tool_result" ? [e.data] : []));
      expect(results).toEqual([
        { type: "tool_result", callId: "a", ok: true, output: 1 },
        { type: "tool_result", callId: "b", ok: false, error: "drive unavailable" },
      ]);
    });

    it("stops at a write tool's approval: an approvals row, the event, and the run waiting", async () => {
      const { model } = scriptedTurns([
        { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara@kestrelpay.example" } }] },
      ]);
      const runId = await newRun();
      const now = new Date("2026-10-14T12:00:00Z");
      expect(await driveRun({ db: t.appDb, loop: loop(model), now: () => now }, leo, runId)).toBe("waiting");
      const s = (await state(leo, runId))!;
      const requested = s.events.find((e) => e.data.type === "approval_requested")!.data;
      expect(requested).toMatchObject({
        call: { callId: "m1", tool: "send_mail" },
        expiresAt: "2026-10-21T12:00:00.000Z",
      });
      const [row] = await t.sql`SELECT * FROM approvals WHERE run_id = ${runId}`;
      expect(row).toMatchObject({ call_id: "m1", tool: "send_mail", status: "pending" });
      expect(row.id).toBe((requested as { approvalId: string }).approvalId);
      expect(s.run.status).toBe("waiting");
    });

    it("resumes a waiting run once its approval is decided, and runs the write once", async () => {
      const { model } = scriptedTurns([
        { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara@kestrelpay.example" } }] },
        { text: "Sent." },
      ]);
      const l = loop(model);
      const runId = await newRun();
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("waiting");
      const s = (await state(leo, runId))!;
      const { approvalId } = s.events.find((e) => e.data.type === "approval_requested")!.data as { approvalId: string };
      await withTenantOn(t.appDb, kestrel, (tx) =>
        append(tx, runId, s.run.version, [{ type: "approval_decided", approvalId, decision: "approved", by: LEO }]),
      );
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("succeeded");
      expect(await types(runId)).toEqual([
        "user_message",
        "status",
        "assistant_turn",
        "approval_requested",
        "status",
        "approval_decided",
        "status",
        "tool_result",
        "assistant_turn",
        "status",
      ]);
    });

    it("fails a run the guard halts, with the reason", async () => {
      const { model } = scriptedTurns([{ text: "never" }]);
      const halted = createRunnerLoop(leo, {
        model,
        tools: fakeTools(),
        reasoningEffort: "medium",
        guard: {
          beforeModelTurn: async () => {
            throw new RunHalted("kill switch: incident 42");
          },
          afterModelTurn: async () => {},
          beforeToolCall: async () => {},
        },
      });
      const runId = await newRun();
      expect(await driveRun({ db: t.appDb, loop: { ...halted, compact: async () => null } }, leo, runId)).toBe(
        "failed",
      );
      expect((await state(leo, runId))!.events.at(-1)!.data).toEqual({
        type: "status",
        from: "running",
        to: "failed",
        reason: "kill switch: incident 42",
      });
    });

    it("leaves a run another runner holds, and picks up a message that lands mid-turn", async () => {
      const runId = await newRun();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const { model } = scriptedTurns([{ text: "first" }, { text: "second" }]);
      const real = loop(model);
      const l = loop(model, {
        modelTurn: async (context, ctx) => {
          l.contexts.push(context);
          if (l.contexts.length === 1) await gate;
          return real.modelTurn(context, ctx);
        },
      });
      const running = driveRun({ db: t.appDb, loop: l }, leo, runId);
      await expect.poll(() => l.contexts.length).toBe(1);
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("busy");
      await addMessage(t.appDb, leo, runId, message("one more thing"));
      release();
      expect(await running).toBe("succeeded");
      // The first turn lost the race to the message, so it was thrown away and the model asked again.
      expect(l.contexts[1].messages.map((m) => m.role)).toEqual(["user", "user"]);
      const turns = (await state(leo, runId))!.events.flatMap((e) =>
        e.data.type === "assistant_turn" ? [e.data.text] : [],
      );
      expect(turns).toEqual(["second"]);
    });

    it("fails the run with an error event when the model throws", async () => {
      const runId = await newRun();
      const l = loop(scriptedTurns([]).model);
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("failed");
      const s = (await state(leo, runId))!;
      expect(s.events.at(-2)!.data).toMatchObject({ type: "error", retryable: false });
      expect(s.events.at(-1)!.data).toMatchObject({ type: "status", from: "running", to: "failed" });
    });

    it("appends a compaction before the model turn when the loop asks for one", async () => {
      const runId = await newRun();
      const { model } = scriptedTurns([{ text: "ok" }]);
      let compacted = false;
      const l = loop(model, {
        compact: async (events) => {
          if (compacted) return null;
          compacted = true;
          return { type: "compaction", throughSeq: events.at(-1)!.seq, summary: "the user said hello" };
        },
      });
      expect(await driveRun({ db: t.appDb, loop: l }, leo, runId)).toBe("succeeded");
      expect(await types(runId)).toEqual(["user_message", "status", "compaction", "assistant_turn", "status"]);
      expect(l.contexts[0].messages[0].role).toBe("user");
      expect((l.contexts[0].messages[0] as { content: string }).content).toContain("the user said hello");
    });
  });

  describe("approvals and cancel (the interface lane D builds on)", () => {
    const loop = (model: ChatModel): RunnerLoop => ({
      ...createRunnerLoop(leo, { model, tools: fakeTools(), reasoningEffort: "medium" }),
      compact: async () => null,
    });
    const mailTurn = { toolCalls: [{ callId: "m1", name: "send_mail", input: { to: "amara@kestrelpay.example" } }] };

    /** A run stopped at its `send_mail` approval; returns the run and approval ids. */
    const waitingRun = async (model: ChatModel, approvalTtlMs?: number) => {
      const runId = await newRun();
      expect(await driveRun({ db: t.appDb, loop: loop(model), approvalTtlMs }, leo, runId)).toBe("waiting");
      const requested = (await state(leo, runId))!.events.find((e) => e.data.type === "approval_requested")!;
      return { runId, approvalId: (requested.data as { approvalId: string }).approvalId };
    };

    it("approves once: the row, the log and a wake; then the run resumes and sends", async () => {
      const { model } = scriptedTurns([mailTurn, { text: "Sent." }]);
      const { runId, approvalId } = await waitingRun(model);
      const woken: unknown[] = [];
      const wake = async (_: Viewer, id: string, why: unknown) => void woken.push([id, why]);

      expect(await decideApproval(t.appDb, nora, approvalId, "approved", wake)).toBe("not-found");
      expect(await decideApproval(t.appDb, nina, approvalId, "approved", wake)).toBe("not-found");
      expect(await decideApproval(t.appDb, leo, "not-a-uuid", "approved", wake)).toBe("not-found");
      expect(await decideApproval(t.appDb, leo, approvalId, "approved", wake)).toBe("ok");
      expect(await decideApproval(t.appDb, leo, approvalId, "rejected", wake)).toBe("not-pending");
      expect(woken).toEqual([[runId, { kind: "approval", approvalId }]]);

      const [row] = await t.sql`SELECT status, decided_by FROM approvals WHERE id = ${approvalId}`;
      expect(row).toEqual({ status: "approved", decided_by: LEO });
      expect((await state(leo, runId))!.events.at(-1)!.data).toEqual({
        type: "approval_decided",
        approvalId,
        decision: "approved",
        by: LEO,
      });
      expect(await driveRun({ db: t.appDb, loop: loop(model) }, leo, runId)).toBe("succeeded");
      const results = (await state(leo, runId))!.events.filter((e) => e.data.type === "tool_result");
      expect(results.map((e) => e.data)).toEqual([
        { type: "tool_result", callId: "m1", ok: true, output: { sent: true } },
      ]);
    });

    it("rejects with the declined result for the model, and the run carries on without sending", async () => {
      const { model } = scriptedTurns([mailTurn, { text: "Understood, I won't send it." }]);
      const { runId, approvalId } = await waitingRun(model);
      expect(await decideApproval(t.appDb, leo, approvalId, "rejected")).toBe("ok");
      expect((await state(leo, runId))!.events.slice(-2).map((e) => e.data)).toEqual([
        { type: "approval_decided", approvalId, decision: "rejected", by: LEO },
        { type: "tool_result", callId: "m1", ok: false, error: expect.stringContaining("rejected") },
      ]);
      expect(await driveRun({ db: t.appDb, loop: loop(model) }, leo, runId)).toBe("succeeded");
    });

    it("refuses a decision past the expiry, and settles the approval as expired", async () => {
      const { model } = scriptedTurns([mailTurn]);
      const { runId, approvalId } = await waitingRun(model, -1000);
      expect(await decideApproval(t.appDb, leo, approvalId, "approved")).toBe("not-pending");
      const [row] = await t.sql`SELECT status, decided_by FROM approvals WHERE id = ${approvalId}`;
      expect(row).toEqual({ status: "expired", decided_by: null });
      expect((await state(leo, runId))!.events.slice(-2).map((e) => e.data.type)).toEqual([
        "approval_decided",
        "tool_result",
      ]);
    });

    it("lists the viewer's approvals; pending keeps the open ones", async () => {
      const { model } = scriptedTurns([mailTurn, mailTurn]);
      const open = await waitingRun(model);
      const decided = await waitingRun(model);
      await decideApproval(t.appDb, leo, decided.approvalId, "approved");

      const pending = await listApprovals(t.appDb, leo, "pending");
      expect(pending.map((a) => a.id)).toContain(open.approvalId);
      expect(pending.map((a) => a.id)).not.toContain(decided.approvalId);
      expect(pending.find((a) => a.id === open.approvalId)).toMatchObject({
        runId: open.runId,
        callId: "m1",
        tool: "send_mail",
        input: { to: "amara@kestrelpay.example" },
        status: "pending",
        decidedBy: null,
        decidedAt: null,
        expiresAt: expect.stringMatching(/Z$/),
        screen: null,
      });
      const all = await listApprovals(t.appDb, leo);
      expect(all.find((a) => a.id === decided.approvalId)).toMatchObject({ status: "approved", decidedBy: LEO });
      expect(await listApprovals(t.appDb, nora, "pending")).toEqual([]);
      expect(await listApprovals(t.appDb, nina)).toEqual([]);
    });

    it("cancels a waiting run: its approval rejected, the run cancelled, once", async () => {
      const { model } = scriptedTurns([mailTurn]);
      const { runId, approvalId } = await waitingRun(model);
      const woken: unknown[] = [];
      const wake = async (_: Viewer, id: string, why: unknown) => void woken.push([id, why]);
      expect(await cancelRun(t.appDb, nora, runId, wake)).toBe("not-found");
      expect(await cancelRun(t.appDb, leo, runId, wake)).toBe("ok");
      expect(await cancelRun(t.appDb, leo, runId, wake)).toBe("final");
      expect(woken).toEqual([[runId, { kind: "cancel" }]]);
      const s = (await state(leo, runId))!;
      expect(s.run.status).toBe("cancelled");
      expect(s.events.slice(-2).map((e) => e.data)).toEqual([
        { type: "approval_decided", approvalId, decision: "rejected", by: LEO },
        { type: "status", from: "waiting", to: "cancelled", reason: "cancelled by the user" },
      ]);
      expect(await listApprovals(t.appDb, leo, "pending")).not.toContainEqual(expect.objectContaining({ runId }));
      expect(await decideApproval(t.appDb, leo, approvalId, "approved")).toBe("not-pending");
    });

    it("cancels mid-turn: the model call in flight is aborted and the run ends cancelled", async () => {
      let started!: () => void;
      const inFlight = new Promise<void>((resolve) => (started = resolve));
      let aborted = false;
      const hanging: ChatModel = {
        id: "hanging",
        async *stream(request) {
          started();
          await new Promise((_, reject) =>
            request.abortSignal!.addEventListener("abort", () => {
              aborted = true;
              reject(request.abortSignal!.reason);
            }),
          );
          yield* [];
        },
      };
      const runId = await newRun();
      const live = holdLive(runId);
      const running = driveRun({ db: t.appDb, loop: loop(hanging) }, leo, runId, live.signal).finally(live.release);
      await inFlight;
      expect(await cancelRun(t.appDb, leo, runId, async (_, id) => void abortLive(id))).toBe("ok");
      expect(await running).toBe("cancelled");
      expect(aborted).toBe(true);
      expect((await state(leo, runId))!.events.at(-1)!.data).toMatchObject({ type: "status", to: "cancelled" });
    });

    it("retries a model turn after a retryable error (a 503), recording it, then succeeds", async () => {
      const { model } = scriptedTurns([{ text: "Done." }]);
      let calls = 0;
      const flaky: ChatModel = {
        id: "flaky",
        stream(request) {
          if (calls++ === 0) throw Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
          return model.stream(request);
        },
      };
      const runId = await newRun();
      expect(await driveRun({ db: t.appDb, loop: loop(flaky), retryBaseMs: 1 }, leo, runId)).toBe("succeeded");
      expect(await types(runId)).toEqual(["user_message", "status", "error", "assistant_turn", "status"]);
      const error = (await state(leo, runId))!.events[2].data;
      expect(error).toEqual({ type: "error", message: "Service Unavailable", retryable: true });
    });
  });
});
