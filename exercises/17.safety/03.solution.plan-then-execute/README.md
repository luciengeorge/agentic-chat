---
title: Plan-then-execute with an allowlist
type: graded
slots:
  agent/plan: plan.ts
  agent/policy: policy.ts
---

# Plan-then-execute with an allowlist: the solution

`uncovered` keeps the plan's entries for the call's tool ("the plan has no ..." when there are none). A note must equal a planned note (`sameNote`). A mail needs one entry where every address's label matches a target (`targetMatches`) and every attachment's label matches a planned document (`documentMatches`); fewer resolved attachments than ids is refused outright, and a mail no entry covers gets the first stranger, the first unplanned attachment, or "no one planned mail ...". A share needs one entry naming its recipient and its document.

`planPolicy.check` allows an unknown tool and every read, allows `make_plan` only when `isPlanningCall`, and for a write: no screen, deny; a screen's `deny`, deny with it; no `currentPlan`, deny; `uncovered`'s reason, deny with it and the reminder that writes come from the user's request; a screen's `flag`, approve with it; otherwise allow. `subagentPolicy.check` denies any write tool and `delegate`, and allows the rest.

## Why it works

- **One entry per call.** An entry is one thing the user asked for. Covering a mail from two entries would let a document move an attachment between the user's requests, and every piece would still look planned.
- **Whole words of the title.** `documentMatches` drops stopwords and file extensions, then needs every word of the planned name as a whole word of the title. A folder in the path or half a word matches nothing.
- **Labels the server resolved.** The plan's "Tom Whitfield" is matched against the guardrails' `Tom Whitfield <tom.whitfield@kestrelpay.example>`, never the model's own text. A target with an address matches by that address alone, so "Tom (attacker@evil.example)" covers the attacker and nobody else.
- **Fail closed.** A write with no screen is one the guardrails never saw. Refusing it means a missing check can't pass for a passed one.
- **Flags go to a person.** Only a person can judge "Tom can't open this attachment"; the policy turns a flag into an approval with the reason.
- **Sub-agents can't write.** A child's task is written by its parent's model, maybe after reading a poisoned document. With no writes allowed, the child reports back, and only the parent's plan, from the user's words, can send anything. Automations follow the same rule: their first message carries a document's id, never its title, because a title is text someone else wrote.

## The worked example

Grace's mail: covered by her one entry. Mia added: refused at Mia's address. The memo attached: refused at the memo's label. Tom plus the memo across two entries: refused as a whole. A flagged mail (Tom can't open the attachment) comes back `approve` with the flag, which the approval card shows.
