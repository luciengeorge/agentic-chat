---
id: sales-cs-escalation-guide
title: Customer Success Escalation Guide
folder: /Sales/Playbooks
filename: Customer Success Escalation Guide.pdf
format: pdf
author: hannah.kim
created: 2025-05-12
modified: 2026-08-28
---

# Customer Success Escalation Guide

Owner: Hannah Kim, Customer Success Manager. Reviewed by Sofia Lindqvist (Compliance) for sections 5 and 6. Last updated 28 August 2026.

This guide tells Support and Customer Success when and how to escalate a merchant problem, and what to say while we fix it.

## 1. Priorities and response targets

| Priority | Definition | First response | Updates | Hours |
|---|---|---|---|---|
| P1 | Merchant cannot take card payments, or cannot pay staff on pay day | 30 minutes | Every hour | 24/7 |
| P2 | A product is degraded or partly failing for the merchant | 4 business hours | Every business day | Support hours |
| P3 | Question, how-to, or a problem with a workaround | 1 business day | When there is news | Support hours |
| P4 | Feature request or feedback | 5 business days | None | Support hours |

Support hours are 07:00 to 22:00 UK time, 7 days a week. Support works from the London and Lisbon offices on weekdays and from home at weekends, when the offices are closed. P1 cases outside those hours go straight to the Payments on-call engineer through PagerDuty.

## 2. Tiers

| Tier | Who | Handles |
|---|---|---|
| Tier 1 | Support team | All new cases, known issues, how-to questions |
| Tier 2 | Customer Success Managers (Hannah Kim leads) | P1 and P2 cases, complaints, credits, anything Tier 1 cannot solve in 1 business day |
| Tier 3 | Engineering on call, through the incident process | Suspected outages, bugs, data problems |

## 3. When to escalate to Engineering

Raise an incident (page Payments on-call) when any of these happen:

- 3 or more merchants report the same error within 15 minutes.
- Merchants report KP-9001, KP-9003 or KP-9007 in growing numbers.
- A payroll payout batch is stuck on pay day.
- Merchants report customers charged twice.
- The status page shows nothing but merchants say the Dashboard or API is down.

Do not wait to be sure. The on-call engineer would rather close a false alarm than miss an outage.

## 4. Error codes Support sees most

| Code | What to do |
|---|---|
| KP-3002 | Account restricted. Do not explain or guess why. Say: "Our team is reviewing the account and will contact you." Send the case to Compliance (Sofia Lindqvist) the same day. |
| KP-4031 | Soft decline, needs 3-D Secure. If one merchant sees a lot of these, their integration is probably not sending 3-D Secure; pass it to Ravi Shah, Sales Engineer. |
| KP-4040 | Blocked by fraud screening. Never say which rule fired or why. Offer the review form; Risk Operations answers within 1 business day. |
| KP-5003, KP-5004 | Confirmation of Payee. The merchant must check the payee's details. We cannot override a no match. |
| KP-5021 | Payment scheme down. Payouts retry for 4 hours on their own. Escalate as P1 if it is pay day. |
| KP-9007 | Acquirer timeout, outcome unknown. Tell the merchant to check the payment status before retrying, and to retry only with the same idempotency key. A retry with a new key can charge the customer twice. |

The full list is in the Payments API Error Code Catalogue in /Engineering/Runbooks. Ask Payments Engineering for anything not covered here.

## 5. Complaints

A complaint is any expression of dissatisfaction, spoken or written, about our service, whether or not the merchant uses the word "complaint".

1. Log it in the complaints register on the day you receive it.
2. Acknowledge it in writing within 1 business day.
3. Send a final response within 15 business days. In exceptional cases, send a holding reply by day 15 that explains the delay, and a final response by day 35.
4. The final response must tell eligible merchants (micro-enterprises and small businesses) that they can refer the complaint to the Financial Ombudsman Service within 6 months.

Sofia Lindqvist reviews the register every month and reports themes to the Exec.

## 6. What never to say

- Why an account is restricted or under review. This can be tipping off, which is a criminal offence.
- Which fraud rule blocked a payment, or any threshold.
- That a problem is "the acquirer's fault" or names a supplier, before Engineering confirms it.
- Promises of a fix time that Engineering has not given you.

## 7. Credits and goodwill

### 7.1 Checkout Pro service credits

Checkout Pro has a 99.95% monthly availability commitment. If availability falls below it, every affected Checkout Pro merchant gets a credit on the next invoice:

| Monthly availability | Credit |
|---|---|
| 99.0% to below 99.95% | 10% of the monthly fee |
| 95.0% to below 99.0% | 25% of the monthly fee |
| Below 95.0% | 50% of the monthly fee |

Engineering confirms availability after each incident. Customer Success sends Finance AP the list of affected merchants, and the credits appear automatically on the next invoice. For INC-2026-0817 on 17 August 2026, August availability was 99.89%, so the 610 affected Checkout Pro merchants get a 10% credit on their August invoice, due out on 5 September.

### 7.2 Goodwill credits

| Who | Limit per merchant per quarter |
|---|---|
| Customer Success Manager | £100 |
| Head of Sales | £500 |
| CFO | Above £500 |

Record every goodwill credit in the CRM with the reason. Goodwill credits are not an admission of fault; say "as a gesture of goodwill".

## 8. Status page wording

Use these first messages and update them as you learn more:

- **Investigating:** "Some card payments are failing. We are investigating and will update this page within 30 minutes."
- **Identified:** "We have found the cause and are working on a fix."
- **Monitoring:** "Card payments have recovered. We are monitoring."
- **Resolved:** "This incident is resolved. If you saw duplicate charges, they will be reversed automatically within 2 business days."

## 9. Contacts

| Need | Contact |
|---|---|
| Customer Success escalations | Hannah Kim |
| Integration problems | Ravi Shah, Sales Engineer |
| Restricted accounts, complaints | Sofia Lindqvist, Compliance Officer |
| Commercial disputes | Jake Morrison, Head of Sales |
| Outages | Payments on-call, through PagerDuty |
