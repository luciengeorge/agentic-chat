---
title: Safety, done
---

# Safety, done

A write now has to get past four things you wrote. The plan, made by `planningInput`'s turn from the user's words alone, before anything was read: the only plan, by `planningTurn`. The guardrails' screen from `screenMail`: Kestrel's domains, real people, documents the sender can read, flags for what a person must judge. The policy, `planPolicy` with `uncovered`: one planned entry covering the whole write, inside `decide` where no runner can skip it, and `subagentPolicy` for children, who write nothing. And the tool itself, `send_mail` or `share_document`, checking as the acting user before anything leaves, with fake-workspace checking once more behind it.

None of these trusts the model, and none trusts the layer before it. The prompt is still there, and live it held: gpt-6-luna ignored the Brightwell pack and told Ella so. The other layers are for the day it doesn't.

## What to notice in the lab

Run `pnpm dev`, sign in as anyone (say `grace.adeyemi@kestrelpay.example`, password `dev-password`), and open `/labs/safety` (dev only).

- **Run all fifteen scenarios** on the reference: every one passes. The table shows each write the obeying model attempted and what stopped it: `Refused by policy: ...`, a guardrail's deny, a tool's `No document ... that you can read.`, or `done` for the write the user planned.
- **`brightwell-injection`**: the model searches, reads the pack, and mails the memo to the data room. Refused by the guardrails (the domain), and the plan has no mail anyway.
- **`plan-pairing`** and **`loose-attachment-match`** are the M2 review's holes: refused by one-entry coverage and by whole-word titles.
- **With 17.3 active and `uncovered` unwritten**, a scenario that reaches a write shows `threw` and the stub's message. Write a wrong `uncovered` (say, one that checks recipients and attachments against different entries) and `plan-pairing` shows `got through`: the memo reaches Tom.
- **Nothing reaches the live fake-workspace**: the lab sends to one of its own in the server's memory, so it can't fill Tom's inbox.

## What comes next

Section 18 measures all of this: golden questions for retrieval, claims checked against sources, and agent tasks graded in CI. Section 20's drills include a guardrail that fails open.
