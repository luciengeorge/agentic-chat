// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { RunEventData, RunStatus } from "#learn/agent/types";

import { applyStatus, IllegalTransitionError, statusOf, transition, TRANSITIONS } from "#learn/agent/state";
import { recordedEvents } from "@/core/agent/state-testing";

const STATUSES = Object.keys(TRANSITIONS) as RunStatus[];
const move = (from: RunStatus, to: RunStatus, reason?: string): RunEventData => ({
  type: "status",
  from,
  to,
  ...(reason ? { reason } : {}),
});
const sent: RunEventData = {
  type: "tool_result",
  callId: "call_zFTm3VfVAJn45FamMz1KbAPa",
  ok: true,
  output: { sent: true },
};

/** What a call threw, or null. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

describe("one move", () => {
  it("allows the ten moves in the table, returning where the run lands", () => {
    for (const from of STATUSES) {
      for (const to of TRANSITIONS[from]) {
        expect(transition(from, to), `${from} -> ${to} is in the table: return the new status`).toBe(to);
      }
    }
  });

  it("refuses the other 39, a final status's every move included, with an IllegalTransitionError", () => {
    const refused = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => !TRANSITIONS[from].includes(to)).map((to) => [from, to] as const),
    );
    expect(refused).toHaveLength(39);
    for (const [from, to] of refused) {
      const error = thrown(() => transition(from, to));
      expect(error, `${from} -> ${to} isn't in the table: throw an IllegalTransitionError`).toBeInstanceOf(
        IllegalTransitionError,
      );
      expect((error as Error).message).toBe(`a run can't go from ${from} to ${to}`);
    }
  });
});

describe("a log's status", () => {
  it("leaves the status alone for events that aren't status moves", () => {
    const data = recordedEvents("kpc-email", 11).map((e) => e.data);
    expect(applyStatus("running", data.slice(2))).toBe("running");
    expect(applyStatus("waiting", [sent]), "a tool result moves nothing").toBe("waiting");
    expect(applyStatus("queued", []), "no events, no move").toBe("queued");
  });

  it("refuses a move that doesn't start where the run is, even when the move itself is legal", () => {
    // The run is waiting; a writer that read it while it was running says running -> succeeded.
    const error = thrown(() => applyStatus("waiting", [move("running", "succeeded")]));
    expect(
      error,
      "running -> succeeded is a legal move, but this run is waiting: compare the event's `from` with the status now",
    ).toBeInstanceOf(IllegalTransitionError);
    expect((error as Error).message, "name the status the run is really in, and where the writer wanted it").toBe(
      "a run can't go from waiting to succeeded",
    );
  });

  it("checks each move against the status the previous one left", () => {
    expect(applyStatus("queued", [move("queued", "running"), move("running", "waiting")])).toBe("waiting");
    const error = thrown(() => applyStatus("queued", [move("queued", "running"), move("queued", "cancelled")]));
    expect(error, "after queued -> running, the run is running: the second event's `from` is stale").toBeInstanceOf(
      IllegalTransitionError,
    );
  });

  it("refuses an illegal move even when its `from` is right", () => {
    const error = thrown(() => applyStatus("queued", [move("queued", "succeeded")]));
    expect(error, "queued can't go straight to succeeded: check the move too").toBeInstanceOf(IllegalTransitionError);
  });

  it("records other events after a final status, but no more moves", () => {
    const late = thrown(() => applyStatus("cancelled", [sent]));
    expect(
      late,
      "a tool result that was in flight when the run was cancelled must still be recorded: refuse moves, not events",
    ).toBeNull();
    expect(applyStatus("cancelled", [sent])).toBe("cancelled");
    expect(
      thrown(() => applyStatus("cancelled", [move("cancelled", "running")])),
      "cancelled goes nowhere: a final status's moves are all refused, by `transition`",
    ).toBeInstanceOf(IllegalTransitionError);
  });

  it("doesn't change the events it reads", () => {
    const data = [move("queued", "running")];
    const copy = structuredClone(data);
    applyStatus("queued", data);
    expect(data).toEqual(copy);
  });
});

describe("the worked example: the recorded runs", () => {
  it("folds Leo's email run: running at seq 2, waiting at 12, running at 14, succeeded at 17", () => {
    const events = recordedEvents("kpc-email");
    expect(events).toHaveLength(17);
    const moves = events.filter((e) => e.data.type === "status").map((e) => e.seq);
    expect(moves).toEqual([2, 12, 14, 17]);
    expect(statusOf(recordedEvents("kpc-email", 1))).toBe("queued");
    expect(statusOf(recordedEvents("kpc-email", 12)), "seq 12 is running -> waiting, for the approval").toBe("waiting");
    expect(statusOf(events)).toBe("succeeded");
  });

  it("refuses the stale approval after the cancel, and still records the result in flight", () => {
    // Tom's smoke run waited on its approval at seq 9 and was cancelled from the inbox at seq 11.
    const events = recordedEvents("cancel-waiting");
    expect(events.at(-1)?.data).toEqual(move("waiting", "cancelled", "cancelled by the user"));
    expect(statusOf(events)).toBe("cancelled");

    // A tab that read the run while it waited approves it, and the runner resumes it: waiting -> running.
    const stale = [...events.map((e) => e.data), move("waiting", "running")];
    const error = thrown(() => applyStatus("queued", stale));
    expect(error, "the run is cancelled: a waiting -> running written after the cancel must be refused").toBeInstanceOf(
      IllegalTransitionError,
    );
    expect((error as IllegalTransitionError).message).toBe("a run can't go from cancelled to running");
    expect(error).toMatchObject({ from: "cancelled", to: "running" });

    expect(
      thrown(() => applyStatus("queued", [...events.map((e) => e.data), sent])),
      "a result after the cancel is still recorded",
    ).toBeNull();
  });
});
