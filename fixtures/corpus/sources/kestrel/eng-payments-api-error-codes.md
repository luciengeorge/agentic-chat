---
id: eng-payments-api-error-codes
title: Payments API Error Code Catalogue
folder: /Engineering/Runbooks
filename: Payments API Error Code Catalogue.pdf
format: pdf
author: julia.novak
created: 2025-06-02
modified: 2026-08-24
traps: [lexical]
---

# Payments API Error Code Catalogue

| Document control | |
|---|---|
| Catalogue version | 2026.3 |
| Last updated | 24 August 2026 |
| Owners | Julia Novak (Payments Product Manager), Emily Tran (Payments Engineering Manager) |
| Applies to | Kestrel Payments API v2, all API versions from 2025-11-01 |
| Public version | The merchant-facing subset is published in the developer docs. This catalogue adds internal notes. |

## How errors are returned

Every failed request returns an HTTP status and a JSON body with a `KP-` code:

```
{
  "error": {
    "code": "KP-4031",
    "message": "Strong Customer Authentication required",
    "decline_code": "sca_required",
    "request_id": "req_8Qm2Tx4Lw9"
  }
}
```

Codes are four digits after `KP-`. The first digit is the family:

| Family | Range | Covers |
|---|---|---|
| 1 | KP-1000 to KP-1999 | Authentication, permissions and rate limits |
| 2 | KP-2000 to KP-2999 | Request validation |
| 3 | KP-3000 to KP-3999 | Merchant account state |
| 4 | KP-4000 to KP-4999 | Card payments and declines (Kestrel Checkout) |
| 5 | KP-5000 to KP-5999 | Payouts (Kestrel Payouts) |
| 9 | KP-9000 to KP-9999 | Kestrel or upstream system faults |

Do not confuse `KP-` error codes with Kestrel Payouts SKUs such as KP-BULK-500. SKUs always contain letters after the prefix.

Always quote the `request_id` when you raise a ticket with Payments Engineering.

## Family 1: authentication and limits

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-1001 | 401 | API key missing or not recognised | No | Send a live key (`kp_live_`) in live mode or a test key (`kp_test_`) in the sandbox, in the `Authorization` header. |
| KP-1002 | 401 | API key revoked | No | Create a new key in Dashboard, Developers, API keys. Old keys are revoked 7 days after a rotation. |
| KP-1003 | 403 | Key lacks the scope for this endpoint | No | Add the scope (for example `payouts:write`) to the key, or use a key that has it. |
| KP-1004 | 403 | Request came from an IP address not on the allowlist | No | Add the address in Dashboard, Developers, IP allowlist. Changes take up to 5 minutes. |
| KP-1009 | 429 | Rate limit exceeded | Yes, after `Retry-After` | Back off and retry. Default limits are 100 requests a second per merchant, and 25 a second for Payouts endpoints. |

## Family 2: validation

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-2001 | 400 | Body is not valid JSON | No | Fix the request body. |
| KP-2004 | 422 | Required field missing | No | `error.field` names the missing field. |
| KP-2007 | 422 | Currency not enabled for this merchant | No | GBP and EUR are enabled by default. Other currencies need a support request. |
| KP-2009 | 422 | Amount out of range | No | Amounts are in minor units. The minimum card payment is 30p or €0.30. |
| KP-2012 | 409 | Idempotency key reused with a different body | No | Reuse a key only to retry the identical request. Use a new key for a new payment. |
| KP-2015 | 422 | Webhook URL is not HTTPS or did not answer | No | Use an HTTPS URL that returns 200 within 10 seconds. |

## Family 3: account state

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-3002 | 403 | Merchant account restricted | No | Contact Kestrel support. See the internal note below. |
| KP-3005 | 403 | Product not enabled on the account | No | Apply for the product in the Dashboard, for example Payouts. |
| KP-3010 | 409 | Settlement bank account not verified | No | Verify the account in Dashboard, Settings, Bank accounts. Settlement is held until it is verified. |
| KP-3014 | 402 | Monthly processing limit reached | No | The limit is shown in Dashboard, Settings, Limits. Ask the account manager for a review. |

**Internal note on KP-3002.** A restriction usually means a KYB or financial crime review is open. Support and Sales must never tell the merchant why the account is restricted, or that a review exists, because that can be tipping off. Route every KP-3002 question to Compliance (Sofia Lindqvist) as described in the Customer Success Escalation Guide.

## Family 4: card payments

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-4001 | 402 | Declined by the issuer, no reason given | Once, after the customer checks their details | Ask the customer to use another card or call their bank. Do not retry the same card more than once in 24 hours. |
| KP-4005 | 402 | Insufficient funds | No | Ask for another payment method. |
| KP-4012 | 402 | Card expired | No | Ask for an up-to-date card. |
| KP-4019 | 402 | Incorrect CVC | Yes, with corrected details | Ask the customer to re-enter the security code. Repeated failures on one card lead to KP-4040. |
| KP-4030 | 402 | Deprecated. Was "3-D Secure required or failed" | n/a | Replaced in March 2026 by KP-4031, KP-4032 and KP-4033. Integrations pinned to API version 2025-11-01 still receive it. |
| KP-4031 | 402 | Soft decline: the issuer requires Strong Customer Authentication | Yes, with 3-D Secure only | Retry the same payment with 3-D Secure by setting `authentication.mode` to `challenge`, and send the customer through their bank's check (app approval or a one-time passcode). A retry without 3-D Secure will be declined again. |
| KP-4032 | 402 | 3-D Secure authentication failed | No | The customer failed their bank's check. Ask them to use another card or contact their bank. |
| KP-4033 | 402 | 3-D Secure abandoned or timed out | Yes, if the customer asks | The customer did not finish the check within 10 minutes. Offer to start the payment again. |
| KP-4040 | 402 | Blocked by Kestrel Shield fraud screening | No | Do not retry. Tell the customer the payment could not be completed and offer another method. Do not say it was flagged as fraud. The merchant can ask support to review the block. |
| KP-4041 | 402 | Issuer declined for suspected fraud | No | Ask the customer to contact their bank. |
| KP-4050 | 402 | Amount over the single transaction limit | No | Limits are £5,000 on Checkout Standard and £20,000 on Checkout Pro. The account manager can request a higher limit. |
| KP-4062 | 402 | Card brand not enabled | No | American Express is off by default. Enable it in Dashboard, Settings, Payment methods. |

**Internal note on KP-4031.** Hosted Checkout pages and the mobile SDKs retry with 3-D Secure automatically, so only merchants on a direct API integration see KP-4031. If one merchant shows more than 5% of attempts ending in KP-4031 over a day, their integration is probably not sending the `authentication` object. Raise it with the Sales Engineer for the account (Ravi Shah for UK direct integrations).

**Internal note on KP-4040.** Support can see which Kestrel Shield rule fired, but must not share rule names or thresholds with merchants or with Sales. The rules are restricted to Payments Engineering and Security.

## Family 5: payouts

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-5001 | 422 | Beneficiary bank details invalid | No | The sort code and account number failed the modulus check, or the IBAN is malformed. Check the details with the payee. |
| KP-5003 | 422 | Confirmation of Payee: no match | No | The name does not match the account. Check with the payee before trying again. |
| KP-5004 | 202 | Confirmation of Payee: close match | Not needed | The payout is held. Confirm it in the Dashboard or with `POST /v2/payouts/{id}/confirm` within 24 hours, or it is cancelled. |
| KP-5010 | 402 | Balance too low to fund the payout | Yes, after funding | Top up the Kestrel Accounts balance, then resubmit. |
| KP-5017 | 409 | Duplicate batch reference | No | A batch with this `batch_reference` was submitted in the last 30 days. Check the first batch before resubmitting, so nobody is paid twice. |
| KP-5021 | 503 | Payment scheme unavailable | No, Kestrel retries | Faster Payments or SEPA Instant is down. Kestrel retries for up to 4 hours, then sends a `payout.failed` webhook. |
| KP-5030 | 422 | SEPA cut-off missed | No, automatic | Standard SEPA payouts received after 14:30 CET go out on the next business day. |

## Family 9: system faults

| Code | HTTP | Meaning | Retry | What the merchant should do |
|---|---|---|---|---|
| KP-9001 | 500 | Internal error | Yes, same idempotency key | Retry with exponential backoff (1, 2, 4, 8 and 16 seconds), then contact support. |
| KP-9003 | 503 | Service temporarily unavailable | Yes, after `Retry-After` | Check status.kestrelpay.example and retry after the `Retry-After` interval. |
| KP-9007 | 504 | Timed out waiting for the card acquirer; outcome unknown | Not as a new payment | Do not create a new payment. Wait 60 seconds, then call `GET /v2/payments/{id}`. If the status is still `pending`, the final status arrives by webhook within 15 minutes. Only ever retry with the same idempotency key: a retry with a new key can charge the card twice. |

**Change note, August 2026.** The KP-9007 guidance was rewritten after incident INC-2026-0817 on 17 August 2026, when merchants retrying KP-9007 with new idempotency keys created duplicate authorisations. Customer Success sent the new wording to every Checkout merchant on a direct integration on 21 August.

## Most frequent declines

Share of all declined card payments, July 2026:

| Code | Share of declines |
|---|---|
| KP-4001 | 31% |
| KP-4005 | 22% |
| KP-4031 | 14% |
| KP-4012 | 9% |
| KP-4019 | 8% |
| KP-4040 | 4% |
| All other codes | 12% |

## Changing this catalogue

New codes are added by a pull request to the `merchant-api` repository that updates `errors.yaml`, with a review from Payments Product. Never reuse a retired code. Codes are deprecated for at least 6 months before removal, and the deprecation is announced in the developer changelog.
