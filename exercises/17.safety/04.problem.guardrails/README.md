---
title: Guardrails at the server boundary
type: graded
slots:
  agent/guardrails: guardrails.ts
---

# Guardrails at the server boundary

👨‍💼 The plan knows what Grace asked for. It doesn't know which domains are Kestrel's, whether `tom.whitfeld@kestrelpay.example` is anyone, or that Tom can't open the Heron memo. The guardrails do: they run on the server, in Grace's tenant, the moment the model proposes a write, and what they find rides on the call for the policy and the approval card.

## Terms

- A **screen** is what the guardrails found for one write: `deny` (never allowed), `flag` (allowed, but the approver must see this), and the `recipients` and `documents` by name.
- The tenant's **mail domains** are the domains of its directory's users: Kestrel's is `kestrelpay.example`.
- A **lookalike domain** ends or begins like Kestrel's without being it: `kestrelpay.example.evil.example`, `evil-kestrelpay.example`.
- A **quote** is 8 or more words in a row from one document. `quotableSpans` cuts a mail's body into the runs to look for.

## Do this

🐨 Write `quotableSpans` and `screenMail` in `playground/guardrails.ts`. The lookups they need are written; `createGuardrails` calls `screenMail` for every mail the model proposes.

## A worked example

The Brightwell pack's address: `mail can only go to kestrelpay.example addresses, and dataroom@brightwell-diligence.example isn't one.` Denied before Ella is ever asked, whatever the plan says.

Daniel Reyes can read the Heron memo; Tom can't. Daniel's mail to Tom with the memo attached is allowed but flagged: `Tom Whitfield can't open the attachment Project Heron Board Memo.pdf (/Exec/Project Heron Board Memo.pdf).` His mail with no attachment but the memo's sentence "If the board approves on 20 October, we will sign on Friday 23 October and complete on Tuesday 1 December 2026." in the body (21 words) is flagged too: `The body quotes "Project Heron Board Memo.pdf", which Tom Whitfield can't read.` The memo names Tom on its insider list; his access says otherwise. That's for Daniel to decide, with the flag in front of him.

Run the tests with `pnpm ex test 17.4`. They need Postgres.
