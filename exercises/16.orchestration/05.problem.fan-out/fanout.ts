// 👨‍💼 Grace's Monday digest covers every new document in /Company: six this week, up to 25 in a busy one. Each
//    document is an agent run of its own, and each run makes model calls, holds part of Grace's daily budget, and
//    holds a database connection while it works. Kestrel runs a fire's runs three at a time, the rest waiting their
//    turn, and stops starting new ones the moment the kill switch is thrown or Grace's budget is spent.
//
// 🦉 Already written in this file: the types. The automation workflow (`src/workflows/automation.ts`) calls your
//    `fanOut` with a fire's items, a limit of 3, an `admit` that asks the kill switch and the owner's budget, and a
//    `run` that starts one agent run as a child workflow and waits for it to end.

/**
 * Fan-out with backpressure (section 16.5). Many items, one child each, but never more than `limit` at once: the
 * rest wait in order for a free slot. Before each child starts, `admit` is asked again, so a kill switch thrown or
 * a budget spent mid-way stops the children that haven't started (the ones running finish on their own guard).
 *
 * It uses nothing but promises, no timers, so a Workflow body can run it: the order children start in depends
 * only on the order the earlier ones finish, which a replay sees again.
 */

export type Admission = { go: true } | { go: false; reason: string };

export interface FanOutOptions<T, R> {
  /** Children running at once, at most. */
  limit: number;
  /** Asked before each child starts. */
  admit?: (item: T, index: number) => Promise<Admission>;
  run: (item: T, index: number) => Promise<R>;
}

export type FanOutResult<R> =
  | { kind: "done"; value: R }
  | { kind: "failed"; error: string }
  | { kind: "skipped"; reason: string };

/** Runs `run` over the items, `limit` at a time, and returns each item's result in item order. Once `admit` says
 * no, every item not yet started is skipped with its reason. */
export async function fanOut<T, R>(items: readonly T[], options: FanOutOptions<T, R>): Promise<FanOutResult<R>[]> {
  // 🐨 Start at most `limit` children at once (at least 1, a whole number). Whenever one finishes, start the next
  //    item that hasn't started, in item order, until every item has a result.
  // 🐨 Before starting each item, ask `admit` (when there is one). Once it says no, that item and every item not
  //    yet started is `{ kind: "skipped", reason }` with its reason, and `admit` isn't asked again. Children
  //    already running carry on.
  // 🐨 A child that throws is `{ kind: "failed", error: <its message> }`, and the others carry on. One that
  //    returns is `{ kind: "done", value }`.
  // 🐨 Return the results in item order, whatever order they finished in.
  // 🐨 The classic mistake: `Promise.all(items.map(run))`. Every document starts at once: 25 runs, 25 model calls
  //    and 25 budget holds in the same second, and nothing left to stop when the kill switch is thrown.
  // 🐨 The other one: batches of `limit`, as section 05.5 does with page ranges. A batch waits for its slowest
  //    child, so two slots sit empty while one long summary finishes.
  //
  // 💰 `Promise.all(promises)` waits for every one. `Math.max`, `Math.min`, `Math.floor`.
  //
  // 🦉 Why no lock around shared counters. JavaScript runs one async function at a time on one thread, and it
  //    switches to another only at an `await`. So code between two `await`s runs whole: a shared variable read and
  //    `++`ed there can't be changed halfway by another child. That's what makes "take the next item" safe without
  //    a mutex.
  // 🦉 Why a limit at all: backpressure. A fire is a burst of work, and everything behind it has a capacity: the
  //    model provider's rate limit, the owner's daily budget (each model call holds its estimate first, section
  //    13.6), the database's connections. Running three at a time and making the rest wait is backpressure: the
  //    fire goes only as fast as what's downstream can take, and the queue holds the rest.
  // 🦉 Why ask before each start. A fire of 25 runs takes minutes. The kill switch thrown at minute two should stop
  //    the 20 runs that haven't started, not wait for them to start and fail one by one at their first turn. The
  //    runs already going stop on their own guard (section 13.6).
  // 🦉 Why no timers. A Workflow body runs this, and it is replayed from its log after a restart (section 15).
  //    With promises alone, which child starts next depends only on which earlier child finished, and the replay
  //    sees the same order. A `setTimeout` poll would be the clock inside a workflow body.
  //
  // 🚨 The tests check the limit and the queue order, a slot refilled as soon as it frees, admission and skipping,
  //    failures, results in item order, no timers, and Grace's six /Company documents three at a time.
  throw new Error(`fanOut(${items.length} items, limit ${options.limit}) isn't written yet`);
}
