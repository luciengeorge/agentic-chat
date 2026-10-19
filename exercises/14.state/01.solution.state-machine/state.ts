import type { RunEventData, RunStatus } from "#learn/agent/types";

/** Where each status may go next. A final status goes nowhere. */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting", "succeeded", "failed", "cancelled", "timed_out"],
  waiting: ["running", "cancelled", "timed_out"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export const FINAL_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "timed_out"];

export const isFinal = (status: RunStatus) => FINAL_STATUSES.includes(status);

export const canTransition = (from: RunStatus, to: RunStatus) => TRANSITIONS[from].includes(to);

export class IllegalTransitionError extends Error {
  override name = "IllegalTransitionError";
  constructor(
    readonly from: RunStatus,
    readonly to: RunStatus,
  ) {
    super(`a run can't go from ${from} to ${to}`);
  }
}

/** Checks one transition and returns where it lands. */
export function transition(from: RunStatus, to: RunStatus): RunStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

/**
 * The status after `events`, starting from `from`. Each `status` event must start where the run is (its `from`)
 * and make a legal move. Any other event leaves the status alone, even after a final one: a tool call that was
 * already running when its run was cancelled still gets its result recorded.
 */
export function applyStatus(from: RunStatus, events: readonly RunEventData[]): RunStatus {
  let status = from;
  for (const event of events) {
    if (event.type !== "status") continue;
    if (event.from !== status) throw new IllegalTransitionError(status, event.to);
    status = transition(status, event.to);
  }
  return status;
}

/** A run's status from its whole log: every run starts `queued`. */
export const statusOf = (events: readonly { data: RunEventData }[]): RunStatus =>
  applyStatus(
    "queued",
    events.map((event) => event.data),
  );
