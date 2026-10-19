// 👨‍💼 Leo watches his run in the chat while it works, and the page shows each step as the run writes it. Then his
//    train goes into a tunnel, or he reloads, or the run waits a day on his approval with the tab open. Each time
//    the page comes back, the server has to send exactly what it missed: nothing twice, nothing skipped. This file
//    is the server's side of the run's stream: `GET /api/runs/<id>/stream` (src/routes/api/runs/-runs.ts) calls it.

import type { RunEvent, RunStatus } from "#learn/agent/types";

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
  // 🐨 Take the first of the two that is a seq: whole digits (spaces around them allowed), at most 9 of them.
  //    The header first, then the query. Neither: 0, the top of the log.
  //
  // 💰 /^\d{1,9}$/.test(value.trim()), Number(...)
  //
  // 🦉 New in this file: `toSse`, written for you. It puts one event on the wire as `id: <its seq>`, then
  //    `data: <the event as JSON>` (one line: JSON.stringify never writes a raw newline), then a blank line.
  // 🦉 Why that id is the seq, and why it matters here. The browser's EventSource keeps the `id` of the last
  //    message it got. When the connection drops, it reconnects by itself and sends that id back as the
  //    `Last-Event-ID` header. The seq is the one number that says where in the log the page is, so the header
  //    hands you back the seq of the last event the page holds. Token lines (`toTokenSse`) carry no id, so the
  //    header always names a stored event.
  // 🦉 Why the header wins. Two things bring a page back. The browser reconnecting on its own sends
  //    `Last-Event-ID` and keeps the URL it first opened, `?after=` included. A reload opens a new EventSource,
  //    which can't send headers, so the page puts its last seq in `?after=` (section 12.4). If both arrive, the
  //    URL is from when the page opened and the header is what it got since: the header is newer.
  // 🦉 Why garbage counts as nothing. The header is whatever the browser kept, and the query is whatever a URL
  //    says. A value that isn't a seq can't say where the page was, so start from the top: the page drops what
  //    it already holds by seq (12.4's `receive`). Sending too much is safe there; sending too little isn't.
  //
  // 🚨 The tests check the header, the query, both, neither, and values that aren't seqs.
  throw new Error(`resumeFrom(${lastEventId}, ${after}) isn't written yet`);
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
  // 🐨 Keep a cursor, `after`, starting at `from`: the seq of the last event sent.
  // 🐨 Loop until `signal` aborts:
  //    - ask the run's status (`run.status()`), THEN the events after the cursor (`run.after(after)`);
  //    - if there are events: move the cursor to the last one's seq, `yield` them, and look again at once (more
  //      may be waiting: `after` returns a page at a time);
  //    - if there are none and the run is gone (null) or final: return, the stream is done;
  //    - otherwise wait `pollMs` (`sleep(pollMs, signal)`, which an abort cuts short) and look again.
  //
  // 💰 Import `isFinal` from "#learn/agent/state".
  // 💰 An `async function*` hands values out with `yield`, and ends with `return`. The route reads it with
  //    `await tail.next()`.
  //
  // 🦉 Why the status before the events. An append writes the run's last events and its final status in one
  //    statement, so they commit together. Read the events first and the status second, and an append can land
  //    in between: no events yet, then "succeeded", and the stream ends without the last event. Read the status
  //    first: if it says final, the events read after it include every event the run will ever have. Ending a
  //    stream is the one decision a tail can get wrong for good, so it's made on a status read before the events.
  // 🦉 Why poll the table. The stream reads the log the runner wrote, and nothing else: whichever process or
  //    runner appended, whenever, the stream sees it. Postgres's LISTEN/NOTIFY would save the polls but needs a
  //    connection held open per stream, which a connection pooler in transaction mode can't give you. A quarter of a second
  //    is fast enough for a timeline; tokens, which need to be faster, come on another path (section 15).
  // 🦉 The classic mistake on reconnect is replaying: starting from 0 again because the request said nothing you
  //    looked at. `from` is where the page already is (`resumeFrom`), so a reconnect sends only what it missed.
  //
  // 📜 https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/async_function*
  //
  // 🚨 The tests drive this with a fake log (an append landing between your two reads, pages of two, a run that
  //    vanishes, an abort), then through the real route on Leo's recorded run: from the top, after a reload, and
  //    after the browser's own reconnect.
  throw new Error(
    `tailEvents(${typeof run}, from ${from}, poll ${pollMs} ms, ${signal ? "a" : "no"} signal) isn't written yet`,
  );
}
