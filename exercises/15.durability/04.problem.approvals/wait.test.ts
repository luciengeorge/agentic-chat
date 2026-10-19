// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { Plan } from "#learn/agent/checkpoint";

import { waitForChange } from "#learn/agent/durable-run";
import { fakeDurable, fakeSignals, fakeSteps } from "@/core/agent/durable-testing";

const APPROVAL = { approvalId: "a8f0c3c2-1b7e-4f43-9a51-0d2e8c7b6a11", callId: "call_4NmkEZ5nioB2ceFw1vL09fLI" };
// Asked for at 08:29:43 on 19 October; 7 days later.
const EXPIRES_AT = "2026-10-26T08:29:43.000Z";
const approval = { approvalId: APPROVAL.approvalId, expiresAt: EXPIRES_AT };
const stillWaiting: Plan = { kind: "waiting", approval: { ...APPROVAL, expiresAt: EXPIRES_AT } };
const token = `agent-approval:${APPROVAL.approvalId}`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
/** The wait's answer, or a failure that says it never came. */
const settled = <T>(waiting: Promise<T>) =>
  Promise.race([
    waiting,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              "waitForChange never returned. Race the read already in flight (`signals.pending`), and call " +
                "`signals.taken()` only once it has fired",
            ),
          ),
        1_000,
      ),
    ),
  ]);

/** `waitForChange` on Grace's approval, with fake steps, hooks and sleeps; the plans it will get, in turn. */
function setup(plans: Plan[] = [stillWaiting]) {
  const log: string[] = [];
  const steps = fakeSteps(plans, log);
  const hook = fakeSignals();
  const durable = fakeDurable(log);
  let answer: string | null = null;
  const waiting = waitForChange(approval, steps.steps, hook.signals, durable.durable).then((a) => (answer = a));
  return { log, hook, durable, waiting, answer: () => answer };
}

describe("waitForChange", () => {
  it("waits on the run's hook when there's no approval: a wake is a change, a cancel is a cancel", async () => {
    const hook = fakeSignals();
    const { steps } = fakeSteps([]);
    const { durable } = fakeDurable();
    const woken = waitForChange(null, steps, hook.signals, durable);
    hook.send({ kind: "wake" });
    expect(await woken).toBe("changed");
    const cancelled = waitForChange(null, steps, hook.signals, durable);
    hook.send({ kind: "cancel" });
    expect(await cancelled).toBe("cancel");
  });

  it("makes the approval's hook, then plans again, so a decision made before the hook existed is seen", async () => {
    // Grace approved in the gap: the plan after the hook finds the run running again.
    const decided: Plan = { kind: "act", version: 13, action: { kind: "tools", calls: [] } };
    const s = setup([decided]);
    await Promise.race([s.waiting, tick().then(tick)]);
    expect(
      s.log,
      "make the hook first, then plan: a hook is registered when the workflow next stops, and the plan step is " +
        "that stop. A plan before the hook, or none, misses a decision made in between",
    ).toEqual([`hook ${token}`, "plan"]);
    expect(s.answer(), "the run isn't waiting on this approval any more: that's a change").toBe("changed");
  });

  it("sleeps until the approval's own expiresAt, and wakes when its hook fires", async () => {
    const s = setup();
    await tick();
    expect(s.log, "sleep until the stored expiresAt (`new Date(approval.expiresAt)`), not 7 days from now").toEqual([
      `hook ${token}`,
      "plan",
      `sleep ${EXPIRES_AT}`,
    ]);
    expect(s.answer(), "nothing has happened yet: keep waiting").toBeNull();
    s.durable.hooks[0].resume({});
    await settled(s.waiting);
    expect(s.answer()).toBe("changed");
    expect(
      s.log.some((l) => l.startsWith("expire")),
      "a decided approval isn't expired",
    ).toBe(false);
  });

  it("expires the approval when the 7 days are up first", async () => {
    const s = setup();
    await tick();
    s.durable.wake();
    await settled(s.waiting);
    expect(s.log.at(-1), "the sleep won: settle the approval as expired (`steps.expire`)").toBe(
      `expire ${APPROVAL.approvalId}`,
    );
    expect(s.answer()).toBe("changed");
  });

  it("decides nothing from the hook's payload: whatever it carries, the next plan reads Postgres", async () => {
    for (const payload of [{ decision: "approved" }, { decision: "rejected" }, { kind: "cancel" }]) {
      const s = setup();
      await tick();
      s.durable.hooks[0].resume(payload);
      await settled(s.waiting);
      expect(
        s.answer(),
        `the approval's hook carried ${JSON.stringify(payload)}: a hook only wakes the run. Anyone who can reach the ` +
          "resume route can send any payload; the decision is the row decideApproval wrote, which the next plan reads",
      ).toBe("changed");
      expect(s.log).toEqual([`hook ${token}`, "plan", `sleep ${EXPIRES_AT}`]);
    }
  });

  it("stops waiting for a cancel on the run's hook, and takes that read", async () => {
    const s = setup();
    await tick();
    s.hook.send({ kind: "cancel" });
    await settled(s.waiting);
    expect(s.answer()).toBe("cancel");
    expect(s.hook.reads(), "a signal that fired is used up: `signals.taken()` starts the next read").toBe(2);
  });

  it("carries on after a wake on the run's hook (a message came in), and doesn't expire anything", async () => {
    const s = setup();
    await tick();
    s.hook.send({ kind: "wake" });
    await settled(s.waiting);
    expect(s.answer()).toBe("changed");
    expect(s.hook.reads()).toBe(2);
    expect(s.log.some((l) => l.startsWith("expire"))).toBe(false);
  });

  it("lets go of the approval's hook however the wait ends", async () => {
    const ends: Array<(s: ReturnType<typeof setup>) => void> = [
      (s) => s.durable.hooks[0].resume({}),
      (s) => s.durable.wake(),
      (s) => s.hook.send({ kind: "cancel" }),
    ];
    for (const end of ends) {
      const s = setup();
      await tick();
      end(s);
      await settled(s.waiting);
      expect(
        s.durable.hooks[0].disposed,
        "dispose of the hook in a `finally`: a hook left registered keeps its token, and the next wait on it can't register",
      ).toBe(true);
    }
  });
});
