---
title: Guardrails at the server boundary
type: graded
slots:
  agent/guardrails: guardrails.ts
---

# Guardrails at the server boundary: the solution

`quotableSpans` splits the body at sentence ends and line breaks, squashes each sentence's whitespace, and for one of 8 words or more adds the 8-word run at every 4th word, ending with the last 8; a `Set` drops repeats, and at most 60 come back.

`screenMail` reads the tenant's mail domains, then for each address: a domain outside them, deny; no enabled principal with that address, deny. Each attachment must be a uuid the sender can `canRead`, else deny. Then the flags: each attachment against each recipient (`principalCanRead`), and each document the body quotes (`quotedDocuments`) that the sender can read, against each recipient. It returns the recipients' labels, the attachments' labels, and the flags joined.

## Why it works

- **The whole domain.** `domains.has(domain)` compares the full domain, so `kestrelpay.example.evil.example` and `evil-kestrelpay.example` are strangers.
- **A real address.** Being at the right domain isn't enough: an address has to belong to an enabled person or group in the directory, so a typo or a leaver can't receive mail.
- **Deny what's never right, flag what a person must judge.** An outside address or an unreadable attachment is never right. A recipient who can't open what they're sent might be a leak or might be the sender's intent; only a person can tell, so it's flagged and the policy asks.
- **Runs every 4 words.** A copied passage of 11 words or more holds a whole 8-word run starting at a multiple of 4 (it starts at most 3 words before one), at a quarter of the searches of checking every word.
- **Nothing leaks through a flag.** Quoted documents the sender can't read are skipped, so a flag never names a document to someone who couldn't open it.
- **On the server, in the tenant.** The guardrails ask Postgres what the model can't know, inside the tenant's transaction, and record it on the call, so `decide` stays pure and the policy reads it from the log.

## The worked example

The data room, the two lookalikes and Harbour's `nina.osei@harbourhealth.example`: denied at the domain. `tom.whitfeld@` and the disabled `peter.hall@`: nobody in the directory. Grace attaching the memo: no document she can read. Daniel to Tom, the memo attached: flagged. Daniel to Tom, the memo's sentence in the body: flagged, the sentence being 21 words, so 5 runs, and the memo's section 1 holds it. Grace sending the same words: no flag, since she can't read the memo.
