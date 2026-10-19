---
title: Approvals that wait days
type: graded
slots:
  agent/durable-run: durable-run.ts
---

# Approvals that wait days: the solution

With no approval, `waitForChange` awaits `signals.pending`, takes it, and answers `cancel` or `changed`. With one, it makes the approval's hook, then calls `steps.plan()`. If the run isn't still waiting on that approval, it answers `changed`. Otherwise it races three promises: the hook (tagged `decided`), `durable.sleep(new Date(approval.expiresAt))` (tagged `expired`) and `signals.pending`. `expired` calls `steps.expire`; the run's hook is taken, and a cancel answers `cancel`; `decided` needs nothing. Then `changed`, and the loop plans again.

## Why it works

- **Hooks only wake; Postgres decides.** `decideApproval` checks the viewer owns the approval, updates the `approvals` row and appends `approval_decided` in one transaction, then resumes the hook with `{}`. The run's next plan reads the decision from the log like any other event. A forged resume costs one plan and changes nothing, and the inbox, the log and the run can never disagree about what Grace decided.
- **Hook first, then look.** `createHook` is registered only when the workflow next stops, and the plan step is that stop. Once it's registered, a decision either landed before it (the plan sees it in the log) or lands after it (the resume finds the hook). Plan before making the hook and there's a gap: a decision in it finds no hook, the plan has already looked, and the run waits a week for something it has.
- **The timer is in Workflow's log.** `sleep(new Date(expiresAt))` writes a wait due at the approval's own expiry. Seven days of waiting hold no process, survive any number of restarts, and on every replay the same sleep is the same wait. The body's own clock can't do this: inside a workflow, `Date.now()` is the time of the latest event, and it doesn't move while the run waits. And `expireStep` settles only a still-pending approval, so if Grace decides at the same moment the timer fires, whichever commits first wins and the other changes nothing.
- **One read of the run's hook.** The race uses the read already in flight and takes it only when it fired. That's how a cancel during the wait isn't lost to a read nobody listens to.
- **`finally` lets go.** Whichever way the wait ends, the approval's hook is disposed, so the next wait on the same approval (after a message, say) can register the token again. Leave it registered and Workflow refuses the second `createHook` with a token conflict.

## The worked example

The sleep's `resumeAt` is the approval's `expiresAt`, 7 days after it was requested. A resume carrying `{ "decision": "approved" }` with nothing decided leaves the run `waiting` with no mail; `decideApproval` and a resume then finish it `succeeded` with one mail. Left alone and woken early, the run appends `approval_decided { decision: "expired", by: null }` and ends `succeeded` with nothing sent.
