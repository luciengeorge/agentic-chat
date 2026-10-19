// @vitest-environment node
import { describe, expect, it } from "vitest";

import { turnFailure } from "#learn/agent/durable";
import { unlessCancelled } from "#learn/agent/durable-run";
import { RunHalted } from "#learn/agent/loop";
import { fakeSignals } from "@/core/agent/durable-testing";

const status = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
const at = (attempt: number, more: { cancelled?: boolean; timedOut?: boolean; retryAfterMs?: number } = {}) => ({
  cancelled: false,
  timedOut: false,
  attempt,
  ...more,
});

/** Work that runs until its signal aborts, then rejects; `stopped` says when it did. */
function liveCall(signal: AbortSignal) {
  let stopped = false;
  const work = new Promise<string>((_, reject) =>
    signal.addEventListener("abort", () =>
      setTimeout(() => {
        stopped = true;
        reject(new DOMException("This operation was aborted", "AbortError"));
      }, 20),
    ),
  );
  return { work, stopped: () => stopped };
}
const within = <T>(promise: Promise<T>, why: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(why)), 1_000))]);

describe("unlessCancelled", () => {
  it("hands back the work's value when it finishes first", async () => {
    const hook = fakeSignals();
    expect(await unlessCancelled(Promise.resolve("turn"), hook.signals, new AbortController())).toEqual({
      value: "turn",
    });
  });

  it("aborts the work on a cancel, waits for it to stop, and returns null", async () => {
    const hook = fakeSignals();
    const controller = new AbortController();
    const call = liveCall(controller.signal);
    const racing = unlessCancelled(call.work, hook.signals, controller);
    hook.send({ kind: "cancel" });
    expect(
      await within(racing, "a cancel came and nothing returned: abort the work through `controller.abort()`"),
    ).toBeNull();
    expect(controller.signal.aborted, "the work is aborted through the run's controller").toBe(true);
    expect(controller.signal.reason).toBe("cancelled");
    expect(call.stopped(), "return only once the aborted work has stopped: await it, ignoring its error").toBe(true);
  });

  it("keeps waiting on the same work through a wake, and still hears a cancel after it", async () => {
    const hook = fakeSignals();
    const controller = new AbortController();
    const call = liveCall(controller.signal);
    const racing = unlessCancelled(call.work, hook.signals, controller);
    hook.send({ kind: "wake" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(controller.signal.aborted, "a wake (a message landed) doesn't stop the turn in flight").toBe(false);
    hook.send({ kind: "cancel" });
    expect(
      await within(racing, "the cancel after a wake was lost: take the fired read (`signals.taken()`) and race again"),
    ).toBeNull();
    expect(hook.reads(), "one read per signal: the wake's, the cancel's, and the next").toBe(3);
  });

  it("returns the work's value when it finishes after a wake", async () => {
    const hook = fakeSignals();
    let finish!: (value: string) => void;
    const work = new Promise<string>((resolve) => (finish = resolve));
    const racing = unlessCancelled(work, hook.signals, new AbortController());
    hook.send({ kind: "wake" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    finish("turn");
    expect(await within(racing, "the work finished after a wake, and nothing came back")).toEqual({ value: "turn" });
  });
});

describe("turnFailure", () => {
  it("calls a cancel a cancel, whatever the aborted call threw", () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    expect(turnFailure(aborted, at(1, { cancelled: true }))).toEqual({ kind: "cancelled" });
    expect(
      turnFailure(status(503), at(1, { cancelled: true })),
      "check the run's own signal first: a cancelled turn isn't retried, even if its error looks retryable",
    ).toEqual({ kind: "cancelled" });
  });

  it("halts on RunHalted, with its reason", () => {
    expect(turnFailure(new RunHalted("daily token budget spent"), at(1))).toEqual({
      kind: "halted",
      reason: "daily token budget spent",
    });
  });

  it("retries the step's own timeout, whatever the error says", () => {
    const aborted = new DOMException("This operation was aborted", "AbortError");
    expect(
      turnFailure(aborted, at(1, { timedOut: true, retryAfterMs: 1 })),
      "the step's timer gave up on a call that hung: that's worth another try",
    ).toEqual({ kind: "retry", message: "This operation was aborted", afterMs: 1 });
  });

  it("retries a 429, a 5xx and a dropped connection, after the wait it's given or the backoff", () => {
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    expect(
      turnFailure(status(429), at(1, { retryAfterMs: 1 })),
      "a wait the caller gives (`retryAfterMs`, 1 ms in tests) beats the backoff",
    ).toEqual({
      kind: "retry",
      message: "HTTP 429",
      afterMs: 1,
    });
    expect(turnFailure(status(503), at(1)), "no wait given: the backoff, 1 s on attempt 1").toEqual({
      kind: "retry",
      message: "HTTP 503",
      afterMs: 1_000,
    });
    expect(turnFailure(reset, at(3))).toEqual({ kind: "retry", message: "fetch failed", afterMs: 4_000 });
  });

  it("fails a 400 or a bug for good: another try sends the same request", () => {
    expect(turnFailure(status(400), at(1, { retryAfterMs: 1 }))).toEqual({ kind: "fatal", message: "HTTP 400" });
    expect(turnFailure(new TypeError("cannot read properties of undefined"), at(1))).toEqual({
      kind: "fatal",
      message: "cannot read properties of undefined",
    });
    expect(turnFailure("a string", at(1))).toEqual({ kind: "fatal", message: "a string" });
  });
});
