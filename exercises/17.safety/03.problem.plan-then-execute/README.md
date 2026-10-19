---
title: Plan-then-execute with an allowlist
type: graded
slots:
  agent/plan: plan.ts
  agent/policy: policy.ts
---

# Plan-then-execute with an allowlist

👨‍💼 Grace's plan says one thing: `send_mail` to "Tom Whitfield", no attachments. Every write her run attempts is now held up against it. Tom gets his mail. A colleague a document mentioned, an attachment nobody asked for, a second mail stitched together from two planned ones: all refused, with a reason the model reads and can pass on to Grace.

## Terms

- A **planned write** is one entry of the plan: the tool, its **targets** (people, groups or addresses, as the user named them), its **documents** (to share or attach) and, for `remember`, the note.
- A write is **covered** when one planned entry names all of it. `uncovered` says why it isn't, or null.
- The **policy** (`planPolicy`) runs inside `decide` for every call: `allow`, `deny` (the call's result is "Refused by policy: ..."), or `approve` (the user decides, even if the tool wouldn't ask).
- A **sub-agent** (section 16) is a child run the agent starts with `delegate`, given a task its parent's model wrote. Its policy is `subagentPolicy`.
- The **allowlist** is what the guardrails and the plan allow together: Kestrel's own domains, people in the tenant, documents the user can read, and only the planned ones.

## Do this

🐨 Write `uncovered` in `playground/plan.ts`, and `planPolicy` and `subagentPolicy` in `playground/policy.ts`.

## A worked example

Grace's recorded plan: `{ tool: "send_mail", targets: ["Tom Whitfield"], documents: [] }`. Her mail to `tom.whitfield@kestrelpay.example`, which the guardrails resolved to `Tom Whitfield <tom.whitfield@kestrelpay.example>`, is covered: allowed, then approved by Grace, then sent.

The same mail with Mia Chen added: `the plan doesn't name mia.chen@kestrelpay.example as a recipient.` With the Heron memo attached: `the plan doesn't name Project Heron Board Memo.pdf (/Exec/Project Heron Board Memo.pdf) as an attachment.` A plan of "mail Tom" and "mail Daniel the Heron memo", and a mail to Tom with the memo: `no one planned mail has all these recipients and attachments together.` These were holes in M2's first version, found in review: entries mixed across a call, attachments matched by words of the path ("Q3 report" covered `/Exec/Reports/heron-memo.pdf`), and sub-agents planning from their task.

Run the tests with `pnpm ex test 17.3`.
