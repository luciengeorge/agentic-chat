---
id: eng-postmortem-inc-2026-0817
title: "Postmortem: INC-2026-0817 Card Authorisation Timeouts"
folder: /Engineering/Incidents
filename: INC-2026-0817 Postmortem.pdf
format: pdf
author: emily.tran
created: 2026-08-20
modified: 2026-09-11
---

# Postmortem: INC-2026-0817, card authorisation timeouts

| Summary | |
|---|---|
| Incident | INC-2026-0817 |
| Date | Monday 17 August 2026 |
| Severity | SEV1 (declared SEV2 at 11:56, raised to SEV1 at 12:02) |
| Customer impact | 11:49 to 12:36 BST, 47 minutes |
| Products affected | Kestrel Checkout card payments. Kestrel Accounts and Kestrel Payouts were not affected. |
| Incident commander | Emily Tran, Payments Engineering Manager |
| On-call | Kofi Mensah (Platform primary), Omar Haddad (Payments primary) |
| Customer comms | Hannah Kim, Customer Success Manager |
| Postmortem review | 25 August 2026, chaired by Priya Nair, CTO |
| Status | Action items open, see section 7 |

This postmortem is blameless. It describes what the system and the process allowed, not who made a mistake.

## 1. What happened

At 11:42 a deploy of `acq-gateway` version 3.18.0 reached 100% of production pods. The release lowered the connection pool for our primary acquirer, Northbridge Acquiring, from 200 to 50 connections per pod. The change was meant for the pool of our secondary acquirer, Corvane Payments, which carries about 8% of traffic.

When the lunchtime peak started, every pod ran out of Northbridge connections. Authorisation requests waited up to 8 seconds for a connection and then timed out. Merchants received KP-9007 (timed out waiting for the card acquirer) and, once the gateway's queue filled, KP-9003 (service temporarily unavailable).

We rolled back to version 3.17.4 at 12:24 and the rollback finished at 12:31. The authorisation success rate was back above 97% at 12:36.

A second problem followed. Many merchants on direct API integrations retried KP-9007 failures as new payments, with new idempotency keys. Where the first attempt had in fact been authorised by the issuer, the customer was authorised twice.

## 2. Impact

| Measure | Value |
|---|---|
| Duration of customer impact | 47 minutes (11:49 to 12:36) |
| Failed authorisation attempts | 31,400 (28,950 KP-9007, 2,450 KP-9003) |
| Peak failure rate | 18.6% of authorisations, at 12:14 |
| Merchants with at least one failure | about 2,900 |
| Of which on Checkout Pro | 610 |
| Payments not completed later (estimate) | 9,800, about £610,000 of merchant sales |
| Kestrel revenue lost (estimate) | about £7,900 |
| Duplicate authorisations | 412: 375 voided before capture, 37 captured and refunded by 17:45 |
| Support tickets | 1,180 on 17 and 18 August |

For the Checkout Pro availability commitment we counted all 47 minutes as downtime. August availability was 99.89%, below the 99.95% commitment, so each affected Checkout Pro merchant received a service credit of 10% of their August monthly fee, about £2,650 in total.

## 3. Timeline (BST, 17 August 2026)

| Time | Event |
|---|---|
| 11:05 | Canary of `acq-gateway` 3.18.0 starts at 5% of pods. |
| 11:20 | Canary gates pass (5xx rate 0.3%, gate 0.5%). Rollout moves to 25%. |
| 11:42 | Rollout reaches 100%. |
| 11:49 | Authorisation success rate starts to fall. KP-9007 responses rise. |
| 11:53 | Alert `checkout-auth-success-rate` (below 92% for 3 minutes) pages Kofi Mensah. |
| 11:56 | Kofi acknowledges, opens the incident channel and declares SEV2. |
| 12:02 | Hannah Kim reports more than 40 merchant tickets in 10 minutes. Raised to SEV1. Emily Tran takes incident commander. |
| 12:07 | Status page updated: "Some card payments are failing. We are investigating." |
| 12:11 | Omar Haddad finds Northbridge pool saturation at 100% on every pod and connection waits of 8 seconds. |
| 12:16 | Sam Patel links the saturation to the 11:42 rollout. |
| 12:18 | Emily approves a rollback to 3.17.4. |
| 12:24 | Rollback starts: `kp-deploy rollback acq-gateway --to 3.17.4`. |
| 12:31 | Rollback complete on all pods. |
| 12:36 | Authorisation success rate above 97%. Customer impact ends. |
| 12:50 | Status page: "Card payments have recovered. We are monitoring." |
| 13:10 | Merchants report customers charged twice. Investigation into duplicates begins. |
| 15:30 | 412 duplicate authorisations identified and 375 voided. |
| 17:45 | Remaining 37 captured duplicates refunded. Downgraded to SEV3. |
| 18 Aug 10:00 | Incident closed. |

Kofi Mensah's handwritten bridge notes are filed in this folder as "INC-2026-0817 Bridge Notes".

## 4. Root cause

The pool size is set per acquirer in `acq-gateway/config/production.yaml`. Pull request #4471 changed `max_connections` under the `northbridge` block instead of the `corvane` block. The acquirer name sits about 40 lines above the changed line, so the diff showed only `max_connections: 200` becoming `max_connections: 50`. Both reviewers approved it as the intended Corvane change.

## 5. Why it was not caught earlier

1. **The canary gates did not measure the right thing.** They checked the HTTP 5xx rate and p99 latency of the canary pods. Pool saturation and the authorisation success rate were not gates.
2. **The canary ran before the peak.** At 25% of pods and morning traffic, 50 connections per pod was enough. The pools only ran dry when lunchtime traffic arrived after the rollout reached 100%.
3. **Nothing validated the config.** Any positive integer was accepted for a pool size.
4. **Our own guidance made duplicates likely.** The error catalogue told merchants that KP-9007 was retryable but did not say to reuse the idempotency key.

## 6. What went well

- The alert fired 4 minutes after impact started and was acknowledged in 3 minutes.
- Customer Success had the status page up 18 minutes after impact started.
- Rollback took 7 minutes from start to finish.

## 7. Action items

| ID | Action | Owner | Due | Status |
|---|---|---|---|---|
| PM-0817-1 | Add authorisation success rate (95% minimum) and pool saturation (80% maximum) to the canary gates for payments-critical services | Sam Patel | 2026-09-04 | Done |
| PM-0817-2 | Validate acquirer pool sizes at build time: Northbridge at least 150 per pod in production | Omar Haddad | 2026-09-11 | Done |
| PM-0817-3 | Rewrite the KP-9007 guidance in the error catalogue and the developer docs: check status first, retry only with the same idempotency key | Julia Novak | 2026-08-24 | Done |
| PM-0817-4 | Email every direct-integration Checkout merchant about safe KP-9007 retries | Hannah Kim | 2026-08-21 | Done |
| PM-0817-5 | No deploys to payments-critical services between 11:30 and 14:00 on weekdays | Nadia Kowalski | 2026-09-01 | Done, in the Deploy Runbook |
| PM-0817-6 | Apply the 10% service credit to affected Checkout Pro merchants on the August invoice | Hannah Kim with Finance AP | 2026-09-05 | Done |
| PM-0817-7 | Detect likely duplicate authorisations (same card, merchant and amount within 2 minutes, different idempotency keys) and alert Payments on-call | Omar Haddad | 2026-10-16 | In progress |
| PM-0817-8 | Show the acquirer name in config diffs by splitting `production.yaml` into one file per acquirer | Kofi Mensah | 2026-10-30 | Not started |
