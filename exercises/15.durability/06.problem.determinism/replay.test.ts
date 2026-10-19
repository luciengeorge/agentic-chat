// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { newRunLog, type RunContext, type RunLog, replay } from "#learn/agent/durable-replay";
import { Crash, graceBody, graceWorld } from "@/core/agent/durable-testing";

const NINE = Date.parse("2026-10-19T09:00:00Z");
const MINUTE = 60_000;
/** A clock that moves on a second each time it's read. */
const ticking = (from: number) => {
  let now = from;
  return () => (now += 1_000);
};
const names = (log: RunLog) => log.steps.map((step) => step?.name);

/** Grace's run started fresh, to the end: its world and its log. */
async function graceRun() {
  const world = graceWorld();
  const log = newRunLog(() => NINE);
  const result = await replay((run) => graceBody(run, world), log, ticking(NINE));
  return { world, log, result };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("replay", () => {
  it("runs a new run's steps for real, and logs each one in the order the body asked for it", async () => {
    const { world, log, result } = await graceRun();
    expect(result).toMatchObject({ kind: "done", value: "succeeded" });
    expect(
      log.steps,
      "every step the body asked for, logged: 12 plans, 5 turns, 5 calls, 4 records and 2 for the approval",
    ).toHaveLength(28);
    expect(names(log).slice(0, 5)).toEqual(["plan", "model_turn", "plan", "tool", "record"]);
    expect(result.ran, "on a new run, every step runs").toEqual(names(log));
    expect(log.steps[1]).toMatchObject({ name: "model_turn", args: "[0]", result: "step_1" });
    expect(log.steps[1]!.at, "a step is logged with the time it finished").toBeGreaterThan(NINE);
    expect([world.modelCalls, world.mails]).toEqual([5, ["agent:run-grace:step_23"]]);
  });

  it("replays a finished run without running anything: every result comes from the log", async () => {
    const { world, log } = await graceRun();
    const again = await replay((run) => graceBody(run, world), log, ticking(NINE + MINUTE));
    expect(again).toEqual({ kind: "done", value: "succeeded", ran: [] });
    expect(
      [world.modelCalls, world.sends.length],
      "a logged step must not run again: its result is in the log, and its work is done",
    ).toEqual([5, 1]);
  });

  it("logs steps started together in the order they were asked for, whatever order they finish in", async () => {
    const body = async (run: RunContext) => {
      const slow = run.step("tool", ["search_documents"], async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "search results";
      });
      const fast = run.step("tool", ["find_person"], async () => "tom.whitfield@kestrelpay.example");
      return Promise.all([slow, fast]);
    };
    const log = newRunLog();
    expect(await replay(body, log)).toMatchObject({
      kind: "done",
      value: ["search results", "tom.whitfield@kestrelpay.example"],
    });
    expect(
      log.steps.map((s) => s?.args),
      "number a step when the body calls it, not when it finishes: the search was asked for first",
    ).toEqual(['["search_documents"]', '["find_person"]']);
    expect(await replay(body, log)).toEqual({
      kind: "done",
      value: ["search results", "tom.whitfield@kestrelpay.example"],
      ran: [],
    });
  });

  it("diverges when the code under an open run asks for another step than its log holds", async () => {
    const { world, log } = await graceRun();
    // A deploy adds a guardrail screen before every tool call. Grace's run was logged by the old code.
    const screened = (run: RunContext) =>
      graceBody(
        {
          step: (name, args, work) =>
            name === "tool"
              ? run.step("screen", args, async () => "ok").then(() => run.step(name, args, work))
              : run.step(name, args, work),
          now: run.now,
        },
        world,
      );
    const result = await replay(screened, log);
    expect(result.kind, "the log no longer describes this code: that's a divergence, never a quiet guess").toBe(
      "diverged",
    );
    if (result.kind !== "diverged") return;
    expect(result.divergence.index).toBe(3);
    expect(result.divergence.message).toBe(
      'replay diverged at step 3: the log has tool("make_plan"), the body asked for screen("make_plan")',
    );
    expect(world.sends, "nothing ran past the divergence").toHaveLength(1);
  });

  it("diverges when a step's arguments changed: the same name isn't the same step", async () => {
    const { world, log } = await graceRun();
    const changed = (run: RunContext) =>
      graceBody(
        {
          step: (name, args, work) => run.step(name, name === "model_turn" ? [`turn ${String(args[0])}`] : args, work),
          now: run.now,
        },
        world,
      );
    const result = await replay(changed, log);
    expect(result.kind, 'compare the arguments too, as JSON: `model_turn(0)` and `model_turn("turn 0")` differ').toBe(
      "diverged",
    );
    if (result.kind === "diverged") expect(result.divergence.index).toBe(1);
  });

  it("diverges even when the body catches the divergence, as `driveRun` catches a failed step", async () => {
    const { world, log } = await graceRun();
    const forgiving = async (run: RunContext) => {
      try {
        await run.step("plan", [], () => world.plan());
        await run.step("model_turn", [99], async () => "a turn the log doesn't have");
        return "carried on";
      } catch {
        return "failed";
      }
    };
    const result = await replay(forgiving, log);
    expect(
      result.kind,
      "keep the first divergence and answer `diverged` whatever the body did with the error: a body that " +
        "swallowed it would be reported as a run that finished",
    ).toBe("diverged");
  });

  it("diverges when a body stops before its log does: a step taken out under an open run", async () => {
    const { world, log } = await graceRun();
    const shorter = async (run: RunContext) => {
      await run.step("plan", [], () => world.plan());
      return "stopped early";
    };
    const result = await replay(shorter, log);
    expect(result.kind).toBe("diverged");
    if (result.kind === "diverged") {
      expect(result.divergence.message).toBe(
        "replay diverged at step 1: the log has model_turn(0), the body asked for the end of the body",
      );
    }
  });

  it("gives the body a clock that's the same on every replay, where the wall clock isn't", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Remind Grace if her approval is more than 2 minutes old; else wait.
    const decide = (now: () => number) => async (run: RunContext) => {
      const asked = await run.step("request_approval", ["send_mail"], async () => NINE);
      return run.step(now() - asked > 2 * MINUTE ? "remind" : "wait", [], async () => "ok");
    };

    vi.setSystemTime(NINE + MINUTE);
    const wallLog = newRunLog();
    await replay((run) => decide(Date.now)(run), wallLog, Date.now);
    const runLog = newRunLog();
    await replay((run) => decide(run.now)(run), runLog, Date.now);
    expect(names(runLog)).toEqual(["request_approval", "wait"]);

    // The run wakes up again at 9:05.
    vi.setSystemTime(NINE + 5 * MINUTE);
    expect(
      (await replay((run) => decide(run.now)(run), runLog, Date.now)).kind,
      "`now()` is the time of the latest step the body has seen, as logged: 9:01 again, so the same branch",
    ).toBe("done");
    const wall = await replay((run) => decide(Date.now)(run), wallLog, Date.now);
    expect(wall.kind, "a body that reads the wall clock took the other branch on replay").toBe("diverged");
    if (wall.kind === "diverged") expect(wall.divergence.got).toBe("remind()");
  });

  it("starts the run's clock at the run's start, the same on every replay", async () => {
    const seen: number[] = [];
    const body = async (run: RunContext) => {
      seen.push(run.now());
      return run.step("plan", [], async () => "go");
    };
    const log = newRunLog(() => NINE);
    await replay(body, log, ticking(NINE + MINUTE));
    await replay(body, log, ticking(NINE + 10 * MINUTE));
    expect(seen, "before any step, `now()` is `log.startedAt`").toEqual([NINE, NINE]);
  });

  it("runs a side effect made outside a step on every replay, and one made in a step once", async () => {
    const sent: string[] = [];
    const careless = async (run: RunContext) => {
      await run.step("plan", [], async () => "send");
      sent.push("from the body");
      await run.step("send_mail", [], async () => void sent.push("from a step"));
      return "done";
    };
    const log = newRunLog();
    for (let wake = 0; wake < 4; wake++) await replay(careless, log);
    expect(
      sent.filter((s) => s === "from a step"),
      "a logged step never runs again",
    ).toHaveLength(1);
    expect(sent.filter((s) => s === "from the body")).toHaveLength(4);
  });

  it("finishes Grace's run after a crash after any of its 16 pieces of work, with one mail to Tom", async () => {
    const rows: string[] = [];
    for (let piece = 1; piece <= 16; piece++) {
      const world = graceWorld();
      const log = newRunLog(() => NINE);
      world.crashAfter(piece);
      const crashed = await replay((run) => graceBody(run, world), log, ticking(NINE)).catch((error: unknown) => error);
      expect(crashed, `the crash after piece ${piece} is thrown on, not taken for a divergence`).toBeInstanceOf(Crash);
      const logged = log.steps.filter(Boolean).length;
      const resumed = await replay((run) => graceBody(run, world), log, ticking(NINE + MINUTE));
      expect(resumed, `resumed after piece ${piece}`).toMatchObject({ kind: "done", value: "succeeded" });
      if (resumed.kind !== "done") continue;
      expect(logged + resumed.ran.length, "the logged steps plus the ones that ran make the whole run").toBe(28);
      expect(world.mails, "one mail, whatever crashed").toEqual(["agent:run-grace:step_23"]);
      rows.push(`${piece}:${logged}:${world.modelCalls}:${world.sends.length}`);
    }
    // After the 14th piece, the send: it left, the log never heard. It runs again with the same stepId, so the
    // same key: two sends, one mail. After a model turn: one more call billed, never a second turn.
    expect(rows.filter((r) => r.startsWith("14:"))).toEqual(["14:23:5:2"]);
    expect(rows.filter((r) => r.endsWith(":6:1")).map((r) => r.split(":")[0])).toEqual(["1", "4", "8", "11", "16"]);
  });
});
