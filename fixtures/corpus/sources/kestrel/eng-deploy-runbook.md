---
id: eng-deploy-runbook
title: Deploy Runbook
folder: /Engineering/Runbooks
filename: deploy-runbook.md
format: md
author: nadia.kowalski
created: 2025-03-10
modified: 2026-09-04
---

# Deploy Runbook

Owner: Nadia Kowalski (Platform Engineering Lead). Maintainers: Sam Patel, Kofi Mensah. Last reviewed 4 September 2026.

This runbook covers deploying any service in the `kestrel-prod` clusters. If it disagrees with what the tooling does, the tooling is right and this page is out of date: fix it in the same week.

## 1. Pipeline

1. Open a pull request. CI runs unit, integration and contract tests. A red build cannot merge.
2. Merge to `main`. CI builds the image, tags it with the version from the release PR, and Argo CD deploys it to `staging` automatically.
3. Check the service in staging. The staging smoke suite runs on every deploy and posts to the Deploys channel in Teams.
4. Promote to production with `kp-deploy promote <service> <version>`. Production runs in AWS eu-west-2 (London). The disaster recovery region, eu-west-1 (Dublin), is updated by the same command within 24 hours, after the London rollout has been stable for 1 hour.

## 2. Change types

| Type | Examples | Approval |
|---|---|---|
| Standard | Most services, config with a schema, feature flag changes | 1 reviewer from the owning team |
| Payments-critical | `acq-gateway`, `payments-core`, `risk-engine`, `ledger`, `payouts-service`, `merchant-api` | 2 reviewers, at least 1 from the owning team, and a change record (CHG) in the change calendar |
| Emergency | A fix or rollback during an incident | The incident commander approves. Raise the CHG record within 1 business day. |

The change record states the service, version, expected effect, rollback version and who is watching the rollout.

## 3. When you can deploy

| Window | Rule |
|---|---|
| Monday to Thursday | 09:30 to 17:00 UK time |
| Friday | 09:30 to 15:00 UK time |
| Weekday lunch peak, 11:30 to 14:00 | No payments-critical deploys (added 1 September 2026 after INC-2026-0817) |
| Last 2 business days of each month | No `payouts-service` or `ledger` deploys: payroll and month-end peak |
| Business day before a UK bank holiday | Nothing after 15:00 |
| Winter freeze, 18 December 2026 to 4 January 2027 | Emergency changes only, approved by Priya Nair |

Anyone can deploy outside these windows only as an emergency change.

## 4. Canary rollout

`kp-deploy promote` rolls out in three steps: 5% of pods for 15 minutes, 25% for 15 minutes, then 100%. Between steps it checks the gates below. If a gate fails for 2 minutes in a row, the rollout stops and rolls back on its own.

| Gate | Applies to | Threshold |
|---|---|---|
| HTTP 5xx rate | All services | Below 0.5% |
| p99 latency | All services | Below the service's SLO, for example 800 ms for `merchant-api` |
| Card authorisation success rate | Payments-critical services | At least 95% |
| Acquirer connection pool saturation | `acq-gateway` | At most 80% |
| Payout submission errors | `payouts-service` | Below 0.2% |

The authorisation success rate and pool saturation gates were added on 4 September 2026 (PM-0817-1). Before that the canary only checked 5xx rate and latency, which is why the bad pool size in INC-2026-0817 passed.

## 5. Commands

```
kp-deploy status <service>                   # versions per region and rollout step
kp-deploy history <service> --since 24h      # recent deploys, who ran them, CHG numbers
kp-deploy promote <service> <version> --chg CHG-12345
kp-deploy pause <service>                    # hold at the current step
kp-deploy rollback <service> --to <version>  # immediate, all pods, no canary
```

`kp-deploy` needs the `deployer` role in Entra ID. Ask Tariq Aziz to add it once your manager approves.

## 6. Rolling back

- Anyone on call can roll back without asking. Say so in the incident channel or the Deploys channel.
- Roll back first and investigate after when a deploy in the last 2 hours lines up with an incident.
- A rollback takes about 7 minutes for `acq-gateway` and under 5 minutes for most other services.
- If the release ran a database migration, check section 7 before rolling back.

## 7. Database migrations

- Use expand and contract. Add the new column or table in one release, move reads and writes in the next, and remove the old one in a third.
- Migrations run as a separate job before the new pods start. The deploy waits for the job to finish.
- Never drop a column in the same release that stops writing it.
- `ledger` migrations need sign-off from Emily Tran and a dry run against the staging copy of production data.
- Every migration must be safe to leave in place if the code is rolled back.

## 8. Feature flags

Use a flag for any behaviour change that can be turned off without a deploy. Flags for payments-critical behaviour start at 10% of traffic and move to 100% after 48 hours without regressions. Remove flags within 30 days of reaching 100%.

## 9. After the deploy

1. Watch the service dashboard for 30 minutes after the rollout reaches 100%.
2. Post the version, CHG number and result in the Deploys channel.
3. Close the change record.

## 10. Contacts

- Platform on-call: page through PagerDuty, rota "platform-primary"
- Payments on-call: rota "payments-primary"
- `kp-deploy` problems: Sam Patel or Kofi Mensah
- Freeze exceptions: Priya Nair, CTO
