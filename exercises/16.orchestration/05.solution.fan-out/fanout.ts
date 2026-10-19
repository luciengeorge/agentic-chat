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
  const limit = Math.max(1, Math.floor(options.limit));
  const results: FanOutResult<R>[] = Array.from({ length: items.length });
  let next = 0;
  let stopped: string | null = null;

  async function lane() {
    while (next < items.length) {
      const index = next++;
      if (stopped === null && options.admit) {
        const admission = await options.admit(items[index], index);
        if (!admission.go) stopped = admission.reason;
      }
      if (stopped !== null) {
        results[index] = { kind: "skipped", reason: stopped };
        continue;
      }
      try {
        results[index] = { kind: "done", value: await options.run(items[index], index) };
      } catch (error) {
        results[index] = { kind: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
