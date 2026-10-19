---
title: Streaming the log
type: graded
slots:
  agent/stream: stream.ts
---

# Streaming the log: the solution

`toSse` writes `id: <seq>`, `data: <the event as JSON>` and a blank line. `resumeFrom` returns the first of the header and the query that is 1 to 9 digits once trimmed, else 0. `tailEvents` keeps a cursor from `from`. Each time round it asks the status, then the events after the cursor. With events, it moves the cursor to the last one and yields them, then goes round at once. With none, it returns if the run is gone or final, and otherwise sleeps `pollMs` (an abort cuts the sleep short and ends the loop).

## Why it works

- **The seq is the bookmark, at both ends.** The server writes it as the SSE `id`, so the browser always knows the last event it holds. Whichever way the page comes back (a reconnect's header, a reload's `?after=`), the server starts after that seq. The client then checks each event's seq once more (12.4's `receive`), so even a stream that sends too much can't show a step twice.
- **Status first, then events.** An append writes a run's last events and its final status in one statement. If the status read says final, that append had committed before it, so the events read that comes after sees every event. Read the other way round, the final append can land between the two reads, and the stream ends one event short. That bug never shows in a demo: it needs the last append to land in a window of a millisecond or two, which is why the test forces it.
- **No wait while there's more.** `after` returns a page at a time (500 in the route), so a stream that starts from the top of a long run drains it page after page before it sleeps.
- **Polling the table, not the runner.** The stream reads only `run_events`. It doesn't care which runner wrote them, in which process, or when, and it needs nothing from Postgres beyond a query: no `LISTEN` connection held open per stream, which a connection pooler in transaction mode (what hosted Postgres usually puts in front) can't give you.
- **Tokens are a side channel.** A token line has no `id`, so `Last-Event-ID` always names a stored event, and a token that arrives late for a turn whose event was sent is dropped by the route. Tokens only come from the Workflow runner, from section 15 on; the stored events are the record.

## The worked example

At seq 12 the stream from the top sends ids 1 to 12, then 13 to 17 as they're appended (approval, `waiting -> running`, the "sent" result, the closing turn, `succeeded`), then ends. `?after=12` sends 13 to 17. `Last-Event-ID: 15` with `?after=12` sends 16 and 17. These are the same numbers section 12.4's page saw on the recorded run: it asked for `?after=12` after its reload.
