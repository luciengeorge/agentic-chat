---
id: eng-architecture-overview
title: Platform Architecture Overview
folder: /Engineering
filename: architecture-overview.md
format: md
author: priya.nair
created: 2025-04-22
modified: 2026-09-15
---

# Platform Architecture Overview

Owner: Priya Nair (CTO). Maintained by Nadia Kowalski (Platform) and Emily Tran (Payments). Last updated 15 September 2026.

This is the map new engineers should read in their first week. It explains what runs where, who owns it, and how money moves through it. Detailed designs live in each service's repository.

## 1. Products and the services behind them

| Product | What it does | Main services |
|---|---|---|
| Kestrel Checkout | Card acceptance online and in person | `merchant-api`, `payments-core`, `risk-engine`, `acq-gateway`, `ledger` |
| Kestrel Accounts | Business current accounts and expense cards | `accounts-service`, `cards-service`, `ledger` |
| Kestrel Payouts | Supplier and payroll payouts | `merchant-api`, `payouts-service`, `risk-engine`, `ledger` |

Shared services: `identity` (merchant users and API keys), `notifications` (email, webhooks, push), `reporting` (statements and exports), `dashboard-web` (the merchant Dashboard).

## 2. Ownership

| Service | Team | Lead |
|---|---|---|
| `merchant-api`, `payments-core`, `acq-gateway`, `risk-engine`, `payouts-service`, `ledger` | Payments | Emily Tran |
| `accounts-service`, `cards-service` | Payments | Emily Tran |
| Clusters, networking, databases, CI/CD, `kp-deploy`, observability | Platform, with Ashgrove for day-to-day operations | Nadia Kowalski |
| `identity`, Entra ID and device management for staff | Platform, with IT | Nadia Kowalski, Tariq Aziz |
| Kestrel Shield rules | Payments, with Security | Omar Haddad, Lena Fischer |

## 3. How a card payment flows

1. The merchant's site, app or Kestrel Tap terminal calls `merchant-api` (`POST /v2/payments`) with an idempotency key.
2. `merchant-api` checks the API key, the scopes and the rate limit, then passes the request to `payments-core`.
3. `payments-core` asks `risk-engine` (Kestrel Shield) for a decision: allow, step up to 3-D Secure, or block with KP-4040.
4. `payments-core` sends the authorisation to `acq-gateway`, which holds connection pools to our two acquirers: Northbridge Acquiring (primary, about 92% of volume) and Corvane Payments (secondary, about 8%, and the failover route).
5. The acquirer returns the issuer's answer. Declines map to KP-4xxx codes; timeouts map to KP-9007.
6. `payments-core` records the result, `ledger` posts the entries, and `notifications` sends the webhook.
7. Captured payments settle to the merchant the next business day, or the same day to a Kestrel Accounts balance on Checkout Pro.

Error codes are defined once in `merchant-api/errors.yaml` and published in the Payments API Error Code Catalogue.

## 4. How a payout flows

1. The merchant submits a payout or a batch to `merchant-api` (`POST /v2/payouts` or `/v2/payout-batches`).
2. `payouts-service` checks the Kestrel Accounts balance (KP-5010 if too low) and runs Confirmation of Payee for UK payees (KP-5003 or KP-5004).
3. `risk-engine` applies the payout rules.
4. UK payouts go out through Faster Payments via Albion Clearing Bank, our sponsor bank. EUR payouts go out through SEPA or SEPA Instant via Banco Meridional in Lisbon.
5. If the scheme is unavailable, `payouts-service` queues the payout and retries for up to 4 hours (KP-5021).

## 5. Money and the ledger

- `ledger` is a double-entry ledger in its own Postgres cluster. Every movement of money is a balanced set of entries; nothing updates a balance directly.
- Customer funds are safeguarded in segregated accounts at Albion Clearing Bank (GBP) and Banco Meridional (EUR), as required for an electronic money institution.
- `ledger-recon` compares ledger balances with the bank safeguarding statements every hour. A difference over £10,000 is a SEV1.

## 6. Infrastructure

| Item | Choice |
|---|---|
| Cloud | AWS, bought through Ashgrove Cloud Services (contract KPC-2026-0142, since 1 April 2026). Primary region eu-west-2 (London), disaster recovery eu-west-1 (Dublin) |
| Operations | Ashgrove runs the clusters, databases and Kafka day to day with 24/7 support. Platform owns the design, the deploy tooling and every change to production. |
| Compute | Kubernetes (EKS), one production cluster per region |
| Deploys | GitHub Actions for CI, Argo CD for staging, `kp-deploy` for production |
| Databases | Aurora Postgres per service; the ledger has its own cluster |
| Messaging | Kafka for payment and payout events |
| Cache | Redis for rate limits, idempotency keys (kept 24 hours) and the Kestrel Shield rule cache |
| Observability | OpenTelemetry into Grafana; alerts route to PagerDuty |
| Staff identity | Microsoft Entra ID with MFA; laptops managed by IT |

Disaster recovery targets: recovery point objective 5 minutes, recovery time objective 1 hour. We last tested failover to eu-west-1 on 9 May 2026. It took 41 minutes.

## 7. Key limits

| Limit | Value |
|---|---|
| API rate limit | 100 requests a second per merchant; 25 a second on Payouts endpoints |
| Single card payment | £5,000 on Checkout Standard, £20,000 on Checkout Pro |
| Idempotency key lifetime | 24 hours |
| Webhook retries | 8 attempts over 24 hours with backoff |
| Northbridge pool per `acq-gateway` pod | 200 connections, validated at build time to be at least 150 |

## 8. Where to go next

- Deploy Runbook and On-call Runbook in /Engineering/Runbooks
- Payments API Error Code Catalogue in /Engineering/Runbooks
- Incident postmortems in /Engineering/Incidents, starting with INC-2026-0817
