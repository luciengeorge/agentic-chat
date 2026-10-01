---
id: eng-incident-bridge-notes-2026-08-17
title: INC-2026-0817 Bridge Notes
folder: /Engineering/Incidents
filename: INC-2026-0817 Bridge Notes.pdf
format: handwriting
author: kofi.mensah
created: 2026-08-17
modified: 2026-08-18
traps: [ocr]
---

# Bridge notes, Mon 17 Aug 2026

Kofi M (Platform on-call). INC-2026-0817

On bridge: Kofi, Omar (Payments on-call), Sam, Emily (IC from 12:02), Hannah (comms). Julia joined about 12:30.

11:53 paged: checkout-auth-success-rate under 92%

11:56 ack. Opened inc channel. SEV2 for now.

- lots of KP-9007 (acquirer timeout), some KP-9003
- Accounts + Payouts look fine, only card auths

12:02 Hannah: 40+ merchant tickets in 10 min. Now SEV1. Emily is IC.

12:07 status page up (Hannah). Wording: "Some card payments are failing"

12:09 checked Northbridge status page: all green. Corvane fine too. So it's us?

12:11 Omar: Northbridge pool 100% saturated on ALL pods, conn wait 8s

12:16 Sam: acq-gateway 3.18.0 went to 100% at 11:42. PR 4471 changed pool 200 to 50?? Meant for Corvane not Northbridge

12:18 Emily OK to roll back to 3.17.4. Not failing over to Corvane, problem is in our gateway not the acquirer

12:20 Hannah asks what to tell merchants. Told her: don't say acquirer, say we're fixing it

12:24 rollback started

12:31 rollback done, all pods

12:36 auth success back over 97%. Impact 11:49 to 12:36 = 47 min

12:50 status page to monitoring. Pool saturation now about 35%, normal for lunch

13:10 Hannah: merchants say customers charged twice. Retrying 9007 with NEW idempotency keys!

- Omar pulling list of dupes
- void what is not captured, refund the rest
- 15:30 Omar: 412 dupes, 375 voided. 37 already captured, refunds going out

To do:

1. canary gates: add auth success rate + pool saturation (Sam)
2. fix KP-9007 wording, say same idempotency key (Julia)
3. service credits for Pro merchants? ask Hannah + Finance
4. no deploys over lunch peak?
5. postmortem draft by Thu (Emily)
6. numbers for the PM: failed auths (about 31k?), merchants hit, how many on Pro. Ask Omar for the query
