// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Plan } from "#learn/agent/checkpoint";
import type { NextAction, ToolCall } from "#learn/agent/types";

import { driveRun, kickAction } from "#learn/agent/durable-run";
import { fakeDurable, fakeSignals, fakeSteps, resultOf } from "@/core/agent/durable-testing";

type Act = Extract<NextAction, { kind: "model" | "tools" | "approval" }>;
const act = (version: number, action: Act): Plan => ({ kind: "act", version, action });
const call = (callId: string, tool: string): ToolCall => ({ callId, tool, input: {} });
const succeeded: Plan = { kind: "final", status: "succeeded" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `driveRun` over scripted plans with fake steps; the log of step calls and the status it ended with. */
async function drive(
  plans: Plan[],
  overrides: Parameters<typeof fakeSteps>[2] = {},
  send?: (s: ReturnType<typeof fakeSignals>) => void,
) {
  const { steps, log } = fakeSteps(plans, [], overrides);
  const hook = fakeSignals();
  const controller = new AbortController();
  const running = driveRun(steps, hook.signals, controller, fakeDurable(log).durable);
  send?.(hook);
  const status = await Promise.race([
    running,
    sleep(2_000).then(() => {
      throw new Error(`driveRun didn't return. It got this far: ${log.join(" | ")}`);
    }),
  ]);
  return { status, log };
}

describe("driveRun: the run as a loop of steps", () => {
  it("plans, does what the plan says, and plans again until the run is final", async () => {
    const { status, log } = await drive([
      act(1, { kind: "model" }),
      act(2, { kind: "tools", calls: [call("c1", "make_plan")] }),
      act(3, { kind: "approval", call: call("c2", "send_mail") }),
      succeeded,
    ]);
    expect(status, "a final plan ends the loop with the plan's status").toBe("succeeded");
    expect(log, "each piece of work is a step, and every step is followed by a fresh plan").toEqual([
      "plan",
      "model@1",
      "plan",
      "tool make_plan",
      "record c1",
      "plan",
      "approval c2@3",
      "plan",
    ]);
  });

  it("runs a turn's calls side by side, and records them once, in call order, whatever order they finish in", async () => {
    let inFlight = 0;
    let most = 0;
    const { log } = await drive(
      [act(4, { kind: "tools", calls: [call("s1", "search_documents"), call("p1", "find_person")] }), succeeded],
      {
        async tool(c) {
          most = Math.max(most, ++inFlight);
          await sleep(c.callId === "s1" ? 40 : 0);
          inFlight--;
          return { kind: "result", result: resultOf(c) };
        },
      },
    );
    expect(most, "the calls ran one after another: start every call's step at once, then wait for them all").toBe(2);
    expect(
      log.filter((l) => l.startsWith("record")),
      "one record step for the turn, with the results in the order the model made the calls",
    ).toEqual(["record s1,p1"]);
  });

  it("fails the run with the reason when a call comes back halted, and records nothing", async () => {
    const { log } = await drive(
      [
        act(5, { kind: "tools", calls: [call("s1", "search_documents"), call("m1", "send_mail")] }),
        { kind: "final", status: "failed" },
      ],
      {
        tool: async (c) =>
          c.tool === "send_mail"
            ? { kind: "halted", reason: "the agent kill switch is on" }
            : { kind: "result", result: resultOf(c) },
      },
    );
    expect(log).toContain("fail the agent kill switch is on");
    expect(
      log.some((l) => l.startsWith("record")),
      "a halted turn records nothing: the run fails instead",
    ).toBe(false);
  });

  it("sends a delegate call to the delegate step with its siblings and the turn's size, and a denied one to a tool step", async () => {
    const denied = { ...call("d2", "delegate"), denied: "a sub-agent can't delegate" } as ToolCall;
    const { log } = await drive([
      act(6, { kind: "tools", calls: [call("d1", "delegate"), denied, call("s1", "search_documents")] }),
      succeeded,
    ]);
    expect(log).toContain("delegate d1 1/3");
    expect(log.filter((l) => l.startsWith("tool"))).toEqual(["tool delegate", "tool search_documents"]);
    expect(log).toContain("record d1,d2,s1");
  });

  it("plans again after a stale model turn, and records nothing for a turn with no results", async () => {
    const { status, log } = await drive(
      [act(7, { kind: "model" }), act(8, { kind: "tools", calls: [call("d1", "delegate")] }), succeeded],
      { modelTurn: async () => "stale", delegate: async () => ({ kind: "skipped" }) },
    );
    expect(status).toBe("succeeded");
    expect(
      log.some((l) => l.startsWith("record")),
      "no results, no record step",
    ).toBe(false);
  });

  it("fails the run with the step's message when a step fails for good, and returns rather than throws", async () => {
    const outcome = await drive([act(9, { kind: "model" })], {
      modelTurn: async () => {
        throw new Error("model turn failed for good: 400 Bad Request");
      },
    }).catch((error: unknown) => ({ threw: error }));
    expect(
      outcome,
      "a step that failed for good ends the run `failed`; the body itself never throws",
    ).not.toHaveProperty("threw");
    const { status, log } = outcome as { status: string; log: string[] };
    expect(status).toBe("failed");
    expect(log.at(-1)).toBe("fail model turn failed for good: 400 Bad Request");
  });

  it("returns not-found for a run Postgres doesn't have, and fails nothing", async () => {
    const { status, log } = await drive([{ kind: "not-found" }]);
    expect(status).toBe("not-found");
    expect(log).toEqual(["plan"]);
  });

  it("waits while the run waits, plans again on a wake, and ends cancelled on a cancel", async () => {
    const waiting: Plan = { kind: "waiting", approval: null };
    const { status, log } = await drive([waiting, waiting], {}, (hook) => {
      hook.send({ kind: "wake" });
      hook.send({ kind: "cancel" });
    });
    expect(status).toBe("cancelled");
    expect(log, "a wake means plan again; a cancel while waiting ends the run").toEqual(["plan", "plan"]);
  });
});

describe("kickAction: one workflow per run", () => {
  it("starts a workflow for a run that has none, and wakes one that's running or pending", () => {
    expect(kickAction(null, null)).toBe("start");
    expect(kickAction("wrun_1", "running")).toBe("wake");
    expect(kickAction("wrun_1", "pending")).toBe("wake");
  });

  it("replaces a workflow only when it has surely ended: completed, failed or gone", () => {
    expect(kickAction("wrun_1", "completed")).toBe("replace");
    expect(kickAction("wrun_1", "failed")).toBe("replace");
    expect(kickAction("wrun_1", "gone")).toBe("replace");
  });

  it("leaves a workflow whose status couldn't be read, rather than start a second driver of the run", () => {
    expect(
      kickAction("wrun_1", null),
      "a status that couldn't be read isn't an ended workflow: a second one would send the run's writes under its " +
        "own step keys, and a mail could go twice",
    ).toBe("leave");
  });

  it("cancels the run to match a workflow cancelled outside the app, rather than start another", () => {
    expect(kickAction("wrun_1", "cancelled"), "someone cancelled it on purpose: reconcile, don't replace").toBe(
      "reconcile",
    );
  });
});
