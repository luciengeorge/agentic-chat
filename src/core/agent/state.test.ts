import { describe, expect, it } from "vitest";

import type { RunStatus } from "./types";

import { applyStatus, canTransition, FINAL_STATUSES, IllegalTransitionError, statusOf, TRANSITIONS } from "./state";

const ALL = Object.keys(TRANSITIONS) as RunStatus[];

describe("the run state machine", () => {
  it.each([
    ["queued", "running"],
    ["queued", "cancelled"],
    ["running", "waiting"],
    ["running", "succeeded"],
    ["running", "failed"],
    ["running", "cancelled"],
    ["running", "timed_out"],
    ["waiting", "running"],
    ["waiting", "cancelled"],
    ["waiting", "timed_out"],
  ] as const)("lets %s go to %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it("allows nothing else", () => {
    const allowed = ALL.flatMap((from) => ALL.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`));
    expect(allowed).toHaveLength(10);
    expect(canTransition("queued", "succeeded")).toBe(false);
    expect(canTransition("waiting", "failed")).toBe(false);
    expect(canTransition("running", "running")).toBe(false);
  });

  it("keeps a final status final", () => {
    for (const from of FINAL_STATUSES) for (const to of ALL) expect(canTransition(from, to)).toBe(false);
  });

  it("folds a log's status events from queued", () => {
    expect(statusOf([])).toBe("queued");
    expect(
      statusOf([
        { data: { type: "user_message", messageId: "m", text: "hi" } },
        { data: { type: "status", from: "queued", to: "running" } },
        { data: { type: "status", from: "running", to: "waiting" } },
        { data: { type: "status", from: "waiting", to: "running" } },
        { data: { type: "status", from: "running", to: "succeeded" } },
      ]),
    ).toBe("succeeded");
  });

  it("refuses an illegal move, and a move that doesn't start where the run is", () => {
    expect(() => applyStatus("queued", [{ type: "status", from: "queued", to: "waiting" }])).toThrow(
      IllegalTransitionError,
    );
    expect(() => applyStatus("running", [{ type: "status", from: "queued", to: "running" }])).toThrow(
      IllegalTransitionError,
    );
  });

  it("records other events after a final status, but no more moves", () => {
    const tool = { type: "tool_result", callId: "c", ok: true, output: null } as const;
    expect(applyStatus("cancelled", [tool])).toBe("cancelled");
    expect(() => applyStatus("cancelled", [{ type: "status", from: "cancelled", to: "running" }])).toThrow(
      IllegalTransitionError,
    );
  });
});
