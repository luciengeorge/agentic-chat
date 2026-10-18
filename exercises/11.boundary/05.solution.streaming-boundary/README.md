---
title: Streaming through the boundary
type: graded
slots:
  boundary/stream: stream.ts
---

# Streaming through the boundary: the solution

`withHeartbeat` takes a reader on `body` and returns a new `ReadableStream`. `start` sets an interval that enqueues `: heartbeat\n\n` (and clears itself if enqueueing throws, the stream having closed). `pull` reads one chunk: done clears the interval and closes; a chunk is enqueued; an error clears the interval and errors the stream. `cancel(reason)` clears the interval, calls `onCancel()`, and cancels the reader with the reason.

## Why it works

- **Comments keep the line warm.** Every 15 seconds of silence gets bytes on the wire, so a proxy's idle timeout never fires. `useChat`'s parser, like every SSE reader, ignores a line starting with `:`.
- **Whole chunks, so whole events.** The UI message stream writes one event per chunk, and a heartbeat only ever goes between chunks.
- **Pull keeps pace with the reader.** The next chunk is read from `body` only when Leo's browser wants one.
- **Cancel stops the work.** `onCancel` aborts the route's controller; its signal went into `answer()` and into the model call, which cuts the request to OpenAI. The route catches the abort and stores `streamed.text` as `aborted`. The request's own `signal` is wired to the same controller, for runtimes that fire it.
- **The timer dies with the stream.** Every way out (done, error, cancel) clears the interval, so a finished stream leaves nothing ticking.

## The worked example

A 40-second silence: heartbeats at 15 s and 30 s, then the event. Leo closing the tab one delta into the London answer: one request to the model, aborted; the stored reply is `aborted` and a prefix of the full answer.

Section 15 meets this again with agent runs, which must outlive a closed tab: there, the run keeps going in a workflow, and the browser reconnects to its stream instead of stopping it.
