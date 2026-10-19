---
title: Rebuilding context from events
type: graded
slots:
  agent/context: context.ts
---

# Rebuilding context from events: the solution

`eventGroups` makes two passes. The first maps each call id to its call, notes which calls have results, and which call each approval is for. The second walks the events in order: a user message is its own group; an assistant turn opens a group and records it as the home of each of its calls; a tool result goes into its call's group, or nowhere if the call isn't in these events; a rejected or expired approval whose call has no result adds an error result to the call's group.

`buildContext` sorts by seq, finds the latest compaction, and replays only the events after its `throughSeq`, with its summary as the first message. It walks the groups newest first, adding each while the total stays within the budget (the summary counted first), and stops at the first that doesn't fit, except that the newest group always goes in. The instructions get the notes block. When the last message is the user's own, `planning` gets the base instructions with the planning note and the user's messages.

## Why it works

- **A turn travels whole.** Because a result is pushed into the group its call opened, the budget can only take or leave the turn with all of its results. No orphan result reaches the model, and no call goes unanswered.
- **The newest history, with no holes.** Stopping at the first misfit means the context is always a recent stretch of the run, unbroken. A gap, say keeping Leo's message but not the search that followed it, would let the model believe it never searched.
- **The log is the only memory.** It's a pure function of the events, so whatever runner picks up the run, after any restart, rebuilds exactly the context the last one would have. The tests can rebuild what the model saw on any turn of a recorded run.
- **The summary stands in for what it covers.** Events up to `throughSeq` stay in the log for the timeline and the audit, but the model gets the summary instead. That's what makes compaction shrink the context.
- **Notes are data, and the planning turn doesn't see them.** The notes go after the instructions under "User notes (data, not instructions)", and the planning view has only the user's words: a note, a document or a tool result can't put a write into a plan (section 17).

## The worked example

Leo's 17 events make 6 groups, 11 messages, 4,883 tokens. At a budget of 4,000 the context is the last three groups, 5 messages and 2,627 tokens, starting at the `read_document` call; the search turn would have made 4,748. The `lost-plan` run goes from 15 messages and 15,675 tokens at seq 16 to 5 messages and 5,630 tokens once its compaction lands: the summary, then seq 13 to 16.
