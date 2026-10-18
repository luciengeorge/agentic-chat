---
title: Frontend, done
---

# Frontend, done

The chat page now runs on your four modules. The conversation page gets its data in its route's loader, both requests at once, before it draws, and the sidebar's list lives in the query cache under one key that the chat refreshes after each answer. `useChat` holds the reply while it streams, and your `replyParts` reads each stage of it, from "Searching your documents…" to the verdict. The chips are numbered by source in reading order, show nothing for a citation the validator dropped, and open the document at its page through a `#page=` fragment the server never sees. An agent run's timeline is the run's event log, each event once by its `seq`, and it comes back after a reload from exactly where the tab left off.

## What to notice in the app

Sign in as `leo.martin@kestrelpay.example` (password `dev-password`).

- **Click the suggestion "What's the daily meal allowance on a work trip?"** The status line says it's searching for about three seconds, then "Reading 8 sources…" for about three and a half more, while the model reasons. Then the words come. Chip 1 opens `Travel and Expenses Policy v2.pdf` at page 2, chip 3 the old policy at £35.
- **Hover a conversation in the sidebar** with the network tab open: the loader's two requests go out before you click.
- **Turn on "Run as agent" and ask it to email Tom Whitfield a contract's payment terms.** Reload while the approval card waits: the timeline is back at once, and the stream asks for `?after=` its last event. Approve from `/inbox` in another tab, and watch the chat's card turn "Approved".
- **Stop an answer halfway** with the stop button, then reload: the part that streamed is stored, marked "Stopped before the answer finished".

## What comes next

Section 13 starts the agent itself: the loop that sends the model a turn, runs the tools it asks for and feeds their results back. Every one of those turns, tool calls and results becomes an event in the log your timeline reads. Section 14 is where that log is built (the `seq`, the optimistic concurrency, the tokens beside it), and section 15 makes the run survive a server restart, which your timeline already survives on the browser's side.
