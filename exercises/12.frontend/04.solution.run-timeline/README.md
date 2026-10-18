---
title: The run timeline and approval inbox
type: graded
slots:
  frontend/run-stream: run-stream.ts
---

# The run timeline and approval inbox: the solution

`receive` first asks whether the state holds an event with this `seq`. If it does, it returns the same state object, and the store does nothing. If not, it returns a new state with the event added; when the event is an `assistant_turn`, `streaming` goes back to `""`. `streamUrl` takes the last event's `seq` and asks for `?after=` it, or for the bare stream when the tab holds none.

## Why it works

- **The seq is the event's identity.** Postgres keeps `(run_id, seq)` unique, so two events with the same seq are the same event. Checking it makes the page safe against any connection that sends too much: a reload that started from the top, an old connection still open, a server that resent its last page. The timeline is a function of the set of events, never of how many times they arrived.
- **Two ways to come back, two places the position lives.** When the connection drops, the browser's `EventSource` reconnects by itself and sends `Last-Event-ID`, which it took from the last `id:` line. Token lines have no `id`, so that's always a stored event. A reload starts a new page and a new `EventSource` that know nothing. So the page keeps its events in sessionStorage, and `streamUrl` turns the last one into `?after=`. The server reads the header first and the query second, so whichever is newer wins.
- **Tokens are a preview, the event is the record.** Tokens arrive only while a page is connected and the model is writing; they're never stored. The `assistant_turn` event holds the same text, whole. So when it arrives, the preview goes: `streaming` back to `""`. The timeline draws the turn from the event, which is also the only copy a page that connected later will ever get.
- **The click asks, the log answers.** Approve sends `POST /api/approvals/<id>` with `{ decision: "approved" }`, and that's all the card does. It turns "Approved" when `approval_decided` comes down the stream from the event log. So the chat and the inbox can't disagree: both show what the server recorded, whichever tab the decision came from.

## The worked example

The first connection, `/api/runs/52a826fa-…/stream`, brought 12 events and 41 tokens. The tokens spelled "I found the contract's payment terms and Tom's directory entry. I'm about to email Tom a two-line summary..." under the timeline; seq 10 arrived with the same text, and the preview went. Seq 11 asked to send "Payment terms — KPC-2026-0142" to tom.whitfield@kestrelpay.example, and seq 12 set the run to waiting.

After the reload, sessionStorage still held seq 1 to 12, so the timeline drew at once and `streamUrl` asked for `?after=12`. Approve posted `{ "decision": "approved" }` to `/api/approvals/71fc5274-…`. The stream then brought seq 13 (`approval_decided`, approved), 14 (running again), 15 (the mail tool's result: "Sent"), 23 tokens and seq 16 ("Emailed Tom Whitfield the two-line summary of payment terms in KPC-2026-0142."), and 17 (succeeded). The tab now holds all 17 events; the stream closed itself, since the run is over.
