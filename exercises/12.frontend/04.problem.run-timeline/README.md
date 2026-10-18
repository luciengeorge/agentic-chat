---
title: The run timeline and approval inbox
type: graded
slots:
  frontend/run-stream: run-stream.ts
---

# The run timeline and approval inbox

👨‍💼 Leo asks the agent to email Tom Whitfield, the financial controller, the payment terms of contract KPC-2026-0142. The chat shows each step as the run takes it: the plan, the search, the contract read, the draft. Then the run stops and waits for Leo to approve the email, which can take a minute or a week. In between he reloads the page, opens the inbox in another tab, closes his laptop. When he comes back, the timeline must be exactly as it was, with no step missing and none shown twice, and the approval must say what was decided, wherever he decided it.

## Terms

- A **run event** is one row of the run's **event log** in Postgres: a message, a model turn, a tool result, an approval asked for or decided, a change of status. Each has a **`seq`**, its place in the run: 1, 2, 3...
- `GET /api/runs/<id>/stream` sends the events as server-sent events, each with `id: <seq>`. In between it sends **token** events, the words of the turn the model is writing. They have no `id`: they're never stored, and the turn's own event holds the whole text.
- **`Last-Event-ID`** is the header the browser's `EventSource` sends when it reconnects by itself: the `id` of the last event it got. The server then sends only what came after. A **reload** makes a new `EventSource` that remembers nothing, so the page itself says where to start, with `?after=<seq>`.
- **sessionStorage** keeps strings for one browser tab, across reloads of that tab.

## Do this

🐨 In `playground/run-stream.ts`, write `receive`, which adds one event to a run's state, and `streamUrl`, where the stream starts. The store around them (one `EventSource` per run, the events kept in sessionStorage) is written.

🚨 The classic mistake is replaying events after a reconnect. The page keeps the events it has seen, then opens the stream from the top again, and every step shows twice. Its twin: keeping the streamed tokens once the turn's event has arrived, so the draft reads twice. The tests check both.

## A worked example

The recorded run has 17 events. The first connection, from the top, brings seq 1 to 12 and 41 token events: the model's words "I found the contract's payment terms and Tom's directory entry..." arrive one token at a time before seq 10 holds them whole. Seq 11 asks for approval of an email to tom.whitfield@kestrelpay.example, subject "Payment terms — KPC-2026-0142", and seq 12 sets the run to waiting. Leo reloads. The tab still holds 12 events, so the new connection is `?after=12`. He approves; the stream brings seq 13 (`approval_decided`), 14 to 16 (running, "Sent", and 23 tokens then the closing turn "Emailed Tom Whitfield the two-line summary of payment terms in KPC-2026-0142.") and 17, succeeded. 17 events in the tab, each shown once.

## In the app

Sign in as `leo.martin@kestrelpay.example`, turn on "Run as agent" and ask "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142." Watch the steps appear and the draft write itself. When the approval card shows, reload: the timeline comes back at once, and the network tab shows `/api/runs/<id>/stream?after=12` (or whatever the last seq was). Open http://localhost:3000/inbox in another tab: the same email waits there, and the sidebar's Inbox badge counts it. Approve it in the inbox. Back in the chat, the card turns "Approved" and the run finishes, because the chat's stream delivered `approval_decided` from the log.

Run the tests with `pnpm ex test 12.4`.
