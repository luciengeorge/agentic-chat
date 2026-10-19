// 👨‍💼 Workflow runs Grace's body again from the top every time her run wakes up: after each step, after her
//    approval, after a restart. Kestrel's engineers keep asking the same two questions: why can't the body read the
//    clock, and why does a deploy under an open run sometimes break it? Build the replayer yourself, small, and both
//    answers fall out.

/**
 * A replayer by hand (section 15.6): how a durable runner such as Workflow resumes a run, small enough to read in one
 * go. The app doesn't use it; Workflow does this for real. It's here to show why a workflow body must be
 * deterministic.
 *
 * A run's log holds what each step returned, at the place the body called it. To resume a run, the replayer runs
 * the body again from the top. The nth step the body asks for gets the log's nth result without running, as long as
 * it's the same step with the same arguments; anything else is a divergence. A step the log doesn't have runs for
 * real, and its result is written to the log the moment it finishes.
 */

export interface LoggedStep {
  name: string;
  /** Its arguments, as JSON. */
  args: string;
  result: unknown;
  /** When it finished, in ms since the epoch. */
  at: number;
}

/** A run's log, as durable storage keeps it: each step's slot is filled when that step finishes. */
export interface RunLog {
  /** When the run started. */
  startedAt: number;
  steps: Array<LoggedStep | undefined>;
}

export const newRunLog = (clock: () => number = Date.now): RunLog => ({ startedAt: clock(), steps: [] });

/** What a step's work is told about itself. */
export interface StepMeta {
  /** The step's place in the run, as an id: the same on every replay, like Workflow's `stepId`. */
  stepId: string;
}

/** What a body gets to work with. */
export interface RunContext {
  /** Runs `run` as the step `name`, once in the run's life: on a replay its logged result comes back instead. */
  step<T>(name: string, args: readonly unknown[], run: (meta: StepMeta) => Promise<T>): Promise<T>;
  /** The run's clock: when it started, then when the latest step the body has had a result from finished. */
  now(): number;
}

/** The body asked for something other than what the log holds at that place. */
export class ReplayDivergence extends Error {
  override name = "ReplayDivergence";
  constructor(
    readonly index: number,
    readonly expected: string,
    readonly got: string,
  ) {
    super(`replay diverged at step ${index}: the log has ${expected}, the body asked for ${got}`);
  }
}

export type Replayed<T> =
  | { kind: "done"; value: T; ran: string[] }
  | { kind: "diverged"; divergence: ReplayDivergence; ran: string[] };

/** A step as messages show it: `tool("send_mail")`. */
export const shown = (name: string, args: string) => `${name}(${args.slice(1, -1)})`;

/**
 * Runs `body` against `log`. Logged steps come back from the log; the others run, and are logged with the time
 * `clock` gives when they finish. `ran` names the steps that ran for real, in the order they started. A body that
 * asks for a different step than the log has at that place, or ends before the log does, has diverged. Anything
 * else the body throws (a crash) is thrown on, with the log as far as it got.
 */
export async function replay<T>(
  body: (run: RunContext) => Promise<T>,
  log: RunLog,
  clock: () => number = Date.now,
): Promise<Replayed<T>> {
  // 🐨 Give the body a `RunContext`, and run it:
  //    - `step(name, args, run)`: number each call in the order the body makes it (0, 1, 2...), at the moment it's
  //      made. If the log has that slot, it must be the same step: same `name`, same `args` as JSON. Then return its
  //      logged `result` without calling `run`. If it's a different step, that's a `ReplayDivergence(index,
  //      <what the log has>, <what the body asked for>)`: keep the first one, and throw it. If the log has no such
  //      slot, add `name` to `ran`, call `run` with the stepId `step_<index>`, and write the result into slot `index`
  //      with the time `clock()` gives as it finishes;
  //    - `now()`: the run's clock. It starts at `log.startedAt` and moves to each step's `at` as the body gets that
  //      step's result, logged or live. It never reads the wall clock.
  // 🐨 When the body returns: a divergence (even one the body caught) answers `diverged`. So does a body that ended
  //    with logged steps it never asked for: diverged at the first of them, against "the end of the body".
  //    Otherwise `done`, with the value and `ran`. When the body throws: a divergence answers `diverged`; anything
  //    else (a crash) is thrown on.
  //
  // 💰 `const index = calls++` takes a number at the call. `JSON.stringify(args)`. `log.steps[index] = { ... }`
  //    fills a slot, even past the end. `Math.max(a, b)`. `shown(name, json)` formats a step for a message.
  //
  // 🦉 Why replay at all. The log is all that survives a crash. A process that starts again doesn't know where the
  //    body was, or what its local variables held; running it again from the top with every finished step answered
  //    from the log rebuilds all of that, and the body arrives at the first step that never finished. That only
  //    works if the body, given the same results, asks for the same steps in the same order. That's what
  //    "deterministic" means here, and why a divergence is an error: the log no longer describes this code.
  // 🦉 Why number a step when it's called, not when it finishes. Two steps started together (Grace's search and her
  //    person lookup) finish in any order. Numbered by finishing, a replay could hand the search's result to the
  //    lookup. Numbered by calling, the body's own order decides, and that order is the same every time.
  // 🦉 Why a clock of its own. A body that reads `Date.now()` to decide ("is the approval past due?") takes one
  //    branch at 9:00 and another when it's replayed at 9:05: the log says one step, the code asks for another.
  //    Workflow pins `Date.now()` inside a body to the time of the latest event, as `now()` does here, and seeds
  //    `Math.random()` per run. What breaks a real replay is anything else that isn't in the log: a global changed
  //    between wake-ups, a value from the network, a request read in the body.
  // 🦉 Why a side effect belongs in a step. A mail sent from the body itself goes out on every replay. Inside a step
  //    it goes out once, and a step cut short by a crash runs again under the same `stepId` (step 2's key).
  //
  // 🚨 The tests run Grace's run as a 28-step log: fresh, replayed whole, and crashed after each piece of work;
  //    then parallel steps, a changed body, a body that reads the wall clock, and one that sends outside a step.
  throw new Error(`replay(${typeof body}, ${log.steps.length} logged steps, ${typeof clock}) isn't written yet`);
}
