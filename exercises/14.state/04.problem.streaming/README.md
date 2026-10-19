---
title: Streaming the log
type: graded
slots:
  agent/stream: stream.ts
---

# Streaming the log

👨‍💼 Leo watches his run in the chat. Each step appears as the run takes it, then the run waits on his approval, and he reloads. Later his laptop sleeps and the browser reconnects on its own. Each time, the server must send exactly what the page missed: no step twice, none skipped, and the stream must end once the run is over, not a moment before its last event.

## Terms

- **Server-sent events** (SSE) are one-way messages from server to browser over a plain HTTP response that stays open. Each message is a few `field: value` lines and a blank line. `id:` names the message; `data:` carries it.
- **Tailing** a log means reading it, sending what's new, waiting a little, and reading again, like `tail -f`.
- A **cursor** is the seq of the last event sent: the next read asks for what's after it.
- **`Last-Event-ID`** is the header the browser's `EventSource` sends when it reconnects by itself: the `id` of the last message it got. A **reload** makes a new `EventSource` that knows nothing, so the page puts its last seq in the URL instead, as `?after=<seq>` (section 12.4 wrote that side).
- A **token** line (`event: token`) carries a few words of a model turn as it's written. Tokens are never stored; the turn's own event has the whole text.

## Do this

🐨 In `playground/stream.ts`, write `toSse` (one event on the wire), `resumeFrom` (where a stream starts) and `tailEvents` (the loop: read the status, read the events after the cursor, send them, wait, again). The route, `GET /api/runs/<id>/stream`, calls all three; `toTokenSse` and `sleep` are written.

🚨 The classic mistake is replaying after a reconnect: a stream that starts from 0 because it never looked at `Last-Event-ID`, so every step shows twice. Its quieter twin reads the events before the status, and ends the stream one event early whenever the last event and the final status land between the two reads. The tests make that happen every time.

## A worked example

Leo's run as it stood at seq 12, waiting. A page opening the stream from the top gets ids 1 to 12. Leo approves, and the rest of the run lands as it really did: seq 13 (`approval_decided`), 14 (`waiting -> running`), 15 (the mail tool's result, "sent"), 16 (the closing turn) and 17 (`succeeded`). The stream sends them as they arrive and then ends, since the run is final and nothing is left.

A reload that kept 12 events asks for `?after=12` and gets 13 to 17, five events. Now say the browser had reached seq 15 on that connection when the wifi dropped: it reconnects to the same URL, still `?after=12`, with `Last-Event-ID: 15`, and must get 16 and 17 only.

Run the tests with `pnpm ex test 14.4`. The last two need Postgres (`pnpm ex up`).
