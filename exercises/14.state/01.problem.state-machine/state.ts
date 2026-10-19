// 👨‍💼 A run's status is what the inbox, the timeline, the runner and the cancel button all go by. Leo cancels a
//    run from the inbox while the runner, which read the run a moment earlier, is about to mark it succeeded.
//    Whichever write comes second must be refused, or a cancelled run reports success and its mail goes out.

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
  // 🐨 If `TRANSITIONS` doesn't list `to` among the moves from `from`, throw an IllegalTransitionError(from, to).
  //    Otherwise return `to`, the status the run is now in.
  //
  // 💰 canTransition(from, to) is already written.
  //
  // 🚨 The tests check every pair of statuses: the ten moves in the table pass, the other 39 throw.
  throw new Error(`transition(${from}, ${to}) isn't written yet`);
}

/**
 * The status after `events`, starting from `from`. Each `status` event must start where the run is (its `from`)
 * and make a legal move. Any other event leaves the status alone, even after a final one: a tool call that was
 * already running when its run was cancelled still gets its result recorded.
 */
export function applyStatus(from: RunStatus, events: readonly RunEventData[]): RunStatus {
  // 🐨 Walk the events in order, keeping the status the run is in (it starts at `from`).
  // 🐨 Skip every event that isn't a `status` event. A tool result, a message, a decision: none of them moves the
  //    run, and none is refused for coming after a final status.
  // 🐨 For a status event, check two things, and throw an IllegalTransitionError for either:
  //    - the event's `from` is the status the run is in now. If it isn't, the writer read an older run.
  //      Throw IllegalTransitionError(<the status now>, <the event's to>): the message then says where the run
  //      really is.
  //    - the move itself is legal: that's `transition`.
  //    Then the run is in the event's `to`.
  // 🐨 Return the status the run ends in.
  //
  // 💰 if (event.type !== "status") continue;
  //
  // 🦉 Why check the event's `from` at all, when `transition` already checks the move? Because a status event is
  //    written by someone who read the run earlier. Take Leo's run, waiting on his approval. He cancels it from
  //    the inbox (waiting -> cancelled). A tab that loaded the run a second before then approves, and the runner
  //    resumes it with waiting -> running. That move is legal from waiting, so `transition` alone lets it
  //    through, and a cancelled run starts running again. The run isn't waiting any more: it's cancelled, and
  //    cancelled goes nowhere. Comparing the event's `from` with the status now is what catches the stale writer.
  //    That's the classic mistake: checking the move the event describes instead of the run it lands on.
  // 🦉 Why let other events through after a final status. A cancel can land while a tool call is in flight. The
  //    call's result still arrives, and the log has to say what happened (the mail went, or didn't). A final
  //    status ends the moves, never the record.
  // 🦉 Why a pure function. The run service (`append`, step 2) calls this on every batch it writes, before the
  //    batch goes in. A refused batch writes nothing, so the log can only ever hold legal moves.
  //
  // 📜 https://en.wikipedia.org/wiki/Finite-state_machine
  //
  // 🚨 The tests fold the recorded runs' logs, refuse a stale writer's move after a cancel (with a message that
  //    names where the run really is), and record a tool result that lands after one.
  throw new Error(`applyStatus(${from}, ${events.length} events) isn't written yet`);
}

/** A run's status from its whole log: every run starts `queued`. */
export const statusOf = (events: readonly { data: RunEventData }[]): RunStatus =>
  applyStatus(
    "queued",
    events.map((event) => event.data),
  );
