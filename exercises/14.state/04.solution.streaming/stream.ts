import type { RunEvent, RunStatus } from "#learn/agent/types";

import { isFinal } from "#learn/agent/state";

/** How often a quiet stream looks at the log again. */
export const STREAM_POLL_MS = 250;

/** One event as an SSE message. `id` is its `seq`, so a client that reconnects sends it back as Last-Event-ID. */
export const toSse = (event: RunEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;

/** A token line: no `id`, so a reconnect's `Last-Event-ID` stays the last event's seq. */
export const toTokenSse = (delta: string) => `event: token\ndata: ${JSON.stringify({ delta })}\n\n`;

/**
 * Where a stream starts: after the `Last-Event-ID` the browser sends when it reconnects by itself, else after
 * `?after=` (a reload says where it was), else from the top. A value that isn't a seq counts as absent.
 */
export function resumeFrom(lastEventId: string | null, after: string | null): number {
  for (const value of [lastEventId, after]) {
    if (value !== null && /^\d{1,9}$/.test(value.trim())) return Number(value.trim());
  }
  return 0;
}

/** What a stream reads, each time it looks: the run's status, then the events after the last one it sent. */
export interface RunTail<E extends { seq: number }> {
  /** The run's status now, or null when it's gone. */
  status(): Promise<RunStatus | null>;
  /** The events after `seq`, oldest first (a page of them). */
  after(seq: number): Promise<E[]>;
}

/** Waits `ms`, or less when `signal` aborts first. */
export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Tails a run's log from `from`: yields each page of new events as it appears, and returns once the run is final
 * and every event is out (or when `signal` aborts). It reads the status before the events: an append writes its
 * events and the run's status in one statement, so once the status read says final, the events read after it
 * holds every event the run will ever have.
 */
export async function* tailEvents<E extends { seq: number }>(
  run: RunTail<E>,
  from: number,
  { pollMs = STREAM_POLL_MS, signal }: { pollMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<E[]> {
  let after = from;
  while (!signal?.aborted) {
    const status = await run.status();
    const events = await run.after(after);
    if (events.length > 0) {
      after = events.at(-1)!.seq;
      yield events;
      continue;
    }
    if (status === null || isFinal(status)) return;
    await sleep(pollMs, signal);
  }
}
