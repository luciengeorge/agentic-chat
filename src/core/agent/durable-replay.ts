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
  const recorded = log.steps.length;
  const ran: string[] = [];
  let calls = 0;
  let seen = log.startedAt;
  let divergence: ReplayDivergence | null = null;

  const context: RunContext = {
    async step<R>(name: string, args: readonly unknown[], run: (meta: StepMeta) => Promise<R>): Promise<R> {
      const index = calls++;
      const json = JSON.stringify(args);
      const logged = log.steps[index];
      if (logged) {
        if (logged.name !== name || logged.args !== json) {
          divergence ??= new ReplayDivergence(index, shown(logged.name, logged.args), shown(name, json));
          throw divergence;
        }
        seen = Math.max(seen, logged.at);
        return logged.result as R;
      }
      ran.push(name);
      const result = await run({ stepId: `step_${index}` });
      const at = clock();
      log.steps[index] = { name, args: json, result, at };
      seen = Math.max(seen, at);
      return result;
    },
    now: () => seen,
  };

  try {
    const value = await body(context);
    const next = log.steps[calls];
    if (!divergence && calls < recorded && next) {
      divergence = new ReplayDivergence(calls, shown(next.name, next.args), "the end of the body");
    }
    return divergence ? { kind: "diverged", divergence, ran } : { kind: "done", value, ran };
  } catch (error) {
    if (divergence) return { kind: "diverged", divergence, ran };
    throw error;
  }
}
