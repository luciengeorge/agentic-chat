---
id: eng-on-call-runbook
title: On-call Runbook
folder: /Engineering/Runbooks
filename: on-call-runbook.md
format: md
author: kofi.mensah
created: 2025-02-17
modified: 2026-08-27
---

# On-call Runbook

Owner: Kofi Mensah (Site Reliability Engineer). Approved by Nadia Kowalski and Emily Tran. Last updated 27 August 2026.

## 1. Rotas

| Rota | Covers | Who |
|---|---|---|
| platform-primary | Clusters, networking, `acq-gateway`, databases, `kp-deploy` | Platform engineers, weekly |
| platform-secondary | Back-up for platform-primary | Platform engineers, weekly |
| payments-primary | `payments-core`, `risk-engine`, `ledger`, `payouts-service`, `merchant-api` | Payments engineers, weekly |
| payments-secondary | Back-up for payments-primary | Payments engineers, weekly |
| eng-manager | Incident commander for SEV1 | Engineering managers, weekly |

`acq-gateway` code is owned by Payments, but platform-primary carries it on call because Platform owns the connection pools and networking.

Rotas hand over on Monday at 10:00 UK time. Pages go through PagerDuty. If primary does not acknowledge within 5 minutes, PagerDuty pages secondary, then the eng-manager rota after 10 minutes.

On-call pay is £250 a week on a primary rota and £125 a week on a secondary rota. A call-out between 22:00 and 07:00 that lasts more than 1 hour earns half a day of time off in lieu, to be taken within 4 weeks. Swap shifts in PagerDuty and tell your manager; do not swap by message alone.

## 2. Severity

| Severity | Definition | Examples | Acknowledge | Status page |
|---|---|---|---|---|
| SEV1 | A core product is failing for many merchants, money may be wrong, or data may be exposed | Card authorisation success below 90% for 5 minutes; a payroll batch cannot be paid on pay day; ledger and bank balances disagree by more than £10,000; suspected data breach | 5 minutes | Within 20 minutes |
| SEV2 | A product is degraded for some merchants, with no workaround | One acquirer failing; SEPA payouts delayed by more than 1 hour; Dashboard login failing for one region | 15 minutes | Within 30 minutes |
| SEV3 | Minor impact or a workaround exists | Reports late; one webhook type delayed; a single merchant affected | Next business day | Not needed |
| SEV4 | No merchant impact | Internal tool broken, noisy alert | Next business day | Not needed |

When in doubt, declare the higher severity. Downgrading later costs nothing.

## 3. First 15 minutes

1. Acknowledge the page.
2. Open an incident channel in Teams named after the incident number (the bot gives you one, for example INC-2026-0817).
3. Declare a severity in the channel.
4. Check what changed: `kp-deploy history --all --since 2h`. If a deploy lines up with the start of the problem, roll it back (see the Deploy Runbook).
5. For SEV1, page the eng-manager rota for an incident commander and ask Customer Success for a comms lead.
6. Post an update in the channel every 15 minutes, even if nothing has changed.

## 4. Roles

- **Incident commander:** owns decisions and the timeline. For SEV1 this is the eng-manager on call. The IC does not debug.
- **Comms lead:** someone from Customer Success (usually Hannah Kim in UK hours). Owns the status page and merchant messages.
- **Scribe:** keeps the timeline in the channel. Handwritten notes are fine if you file them in /Engineering/Incidents afterwards.
- **Responders:** debug and fix.

## 5. Escalation

| Situation | Who |
|---|---|
| SEV1 not mitigated after 30 minutes | Priya Nair, CTO |
| Suspected security incident or data exposure | Lena Fischer (Security), then Helen Marsh (General Counsel). Personal data breaches may have to be reported to the ICO within 72 hours. |
| Incident that may need to be reported to the FCA | Sofia Lindqvist (Compliance Officer) |
| AWS fault in the clusters, databases or Kafka | Ashgrove Cloud Services 24/7 operations desk: open a P1 with them and add their engineer to the incident channel |
| Acquirer outage | Northbridge Acquiring operations line, or move traffic to Corvane Payments (section 6) |
| Faster Payments or SEPA problem | Albion Clearing Bank or Banco Meridional operations desk, numbers in the PagerDuty service notes |

## 6. Common actions

### Card authorisations failing

- Check the `checkout-auth-success-rate` dashboard and the share of KP-9007 and KP-9003 responses.
- Check `acq-gateway` pool saturation. Above 80% on all pods means the gateway, not the acquirer, is the bottleneck.
- If Northbridge itself is failing, move traffic: `acqctl route --to corvane --percent 35`. Corvane's contract covers up to 35% of our peak authorisation volume; above that, call Corvane's operations line first.
- Tell Customer Success that merchants must not retry KP-9007 with a new idempotency key (see the Payments API Error Code Catalogue).

### Payouts delayed

- Check `payouts-scheme-errors`. A burst of KP-5021 means the scheme is down; `payouts-service` retries for up to 4 hours on its own.
- On pay day, a payroll batch stuck for more than 30 minutes is SEV1.

### Kestrel Shield alerts

- A block rate over 2.0% or an FR-110 card-testing page goes to payments-primary. The rules are in "Kestrel Shield Fraud Rules", which only Payments Engineering and Security can open.

## 7. After the incident

- SEV1 and SEV2 need a postmortem within 5 business days, using the template in /Engineering/Incidents.
- Postmortems are reviewed at the reliability review on Tuesdays at 14:00.
- Action items get an owner and a due date, and are tracked in the RELY project.

## 8. Handover checklist

- Open incidents and their state
- Alerts that fired more than twice in the week
- Planned changes in the coming week (check the change calendar)
- Anything you silenced, and when it unsilences
