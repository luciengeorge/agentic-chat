---
title: Streaming through the boundary
type: graded
slots:
  boundary/stream: stream.ts
---

# Streaming through the boundary

👨‍💼 Leo's answer streams from `POST /api/chat`. Before the first word there can be seconds of nothing while the question is rewritten, searched, reranked and reasoned about, and a proxy between his laptop and Kestrel may decide a silent connection is dead. After the first word, Leo may close the tab, and then every further token gpt-6-luna writes is paid for and read by nobody. The route needs to keep a quiet stream alive, and to stop the work the moment the reader leaves.

## Terms

- A **ReadableStream** is the web's stream of bytes. The **reader** pulls chunks from it; the stream's **source** (`start`, `pull`, `cancel`) produces them.
- **Cancel** is the reader giving up: the browser closed the connection, and the server's response stream is cancelled.
- A **heartbeat** is a few bytes sent only to show the connection is alive. In server-sent events, a line starting with `:` is a **comment**: readers skip it.
- An **AbortController** makes a **signal**; `abort()` fires it, and everything it was handed (here, the model call) stops.
- **Backpressure** is a slow reader slowing the producer down, instead of the producer piling chunks up.

## Do this

🐨 Write `withHeartbeat` in `playground/stream.ts`: pass `body`'s chunks through, send `: heartbeat` every `intervalMs` while open, clear the timer when it ends, and on cancel call `onCancel` and cancel `body`. `handleChat` wraps its response in it, with an `onCancel` that aborts the answer.

## A worked example

`HEARTBEAT_MS` is 15,000. A turn that's silent for 40 seconds sends `: heartbeat` at 15 s and 30 s, then its first event at 40 s: three chunks, and the connection never sits idle for more than 15 seconds.

Leo's London answer replayed slowly, 512 bytes every 10 ms of its 56,339: Leo's browser reads up to the first text delta and closes the tab. Your `cancel` calls `onCancel`, the controller aborts, the replayed connection to "OpenAI" is cut, and the route stores a reply with status `aborted` holding only the start of "The v2 policy sets the London hotel limit at **£200 per night**...". Without the `onCancel`, the model reads to the end and the reply is stored as if Leo had seen it.

Run the tests with `pnpm ex test 11.5`. The last one needs Postgres (`pnpm ex up`).
