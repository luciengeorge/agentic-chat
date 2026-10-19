---
title: Approvals that wait days
type: graded
slots:
  agent/durable-run: durable-run.ts
---

# Approvals that wait days

👨‍💼 Grace's send waits for her approval. She may approve in a minute from the inbox, or next Tuesday, or never. Meanwhile the run must hold nothing (no worker, no open request), survive every restart, notice her decision at once, and give up by itself after 7 days. In step 3 it only woke when the app kicked it, and it never gave up.

## Terms

- A **hook** pauses a workflow until someone calls `resumeHook(token, payload)`. The **token** names it: here `agent-approval:<approval id>`. `createHook` makes one; it's registered when the workflow next stops to wait.
- A **sleep** pauses a workflow until a time. It's a timer in Workflow's log: nothing runs while it waits, and a restart doesn't reset it. A test ends one early with `wakeUp`.
- The **payload** is what `resumeHook` sends. Anyone who can call a resume route can send any payload.
- **Expired**: an approval nobody decided within 7 days (604,800,000 ms, `APPROVAL_TTL_MS`). It's written to the log like a decision, by nobody, and the call gets a declined result.

## Do this

🐨 In `playground/durable-run.ts`, write `waitForChange`. With no approval, the run waits on its own hook, as before. With one, it makes the approval's hook, plans again, then races the hook, a sleep until the approval's `expiresAt`, and the run's own hook.

🚨 The classic mistake is to take the decision from the hook's payload: "the resume said approved, so send". The decision is the row `decideApproval` wrote, after checking the user owns the approval. The hook only says "go and look".

## A worked example

Grace's run reaches her send and waits: the approval's `expiresAt` is 7 days after it was asked for, and the workflow sleeps until exactly that time (Workflow's `wait_created` has the same `resumeAt`). Someone resumes her approval's hook with `{ "decision": "approved" }`, without deciding anything: the run plans, finds the approval still pending, and waits again; no mail. Grace then approves for real, and the run sends one mail and ends `succeeded`.

In a second run nobody decides. The test ends the 7-day sleep at once with `wakeUp`. The run settles the approval as `expired` (`by: null`), the model is told the send was declined, and the run ends `succeeded` with nothing sent.

Run the tests with `pnpm ex test 15.4`. They need Postgres (`pnpm ex up`).
