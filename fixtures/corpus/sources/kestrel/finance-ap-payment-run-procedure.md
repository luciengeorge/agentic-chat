---
id: finance-ap-payment-run-procedure
title: Supplier Payment Run Procedure
folder: /Finance/AP
filename: Supplier Payment Run Procedure.docx
format: docx
author: grace.adeyemi
created: 2025-03-10
modified: 2026-06-02
---

# Supplier payment run procedure

**Version 2.3, 2 June 2026. Owner: Grace Adeyemi (Accounts Payable Specialist). Approved by Tom Whitfield (Financial Controller).**

## 1. Scope

This procedure covers every payment to suppliers from the operating accounts of Kestrel Pay Ltd (GBP, Albion Clearing Bank) and Kestrel Pay Europe Ltd (EUR, Banco Meridional). It does not cover merchant settlements or payouts, which run through the payments platform, or any movement on the safeguarding accounts, which follows the safeguarding reconciliation procedure.

## 2. Schedule

We pay suppliers twice a week.

| Run | Cut-off for approved invoices | Proposal ready | Payments released by |
|---|---|---|---|
| Tuesday | Monday 12:00 | Tuesday 10:00 | Tuesday 14:00 |
| Thursday | Wednesday 12:00 | Thursday 10:00 | Thursday 14:00 |

- If a run day is a UK bank holiday, the run moves to the next working day.
- Invoices approved after the cut-off go in the next run.
- The AP cut-off for month end is 17:00 on the last working day. Invoices received later are posted to the next month (month-end close checklist, item 2).
- SEPA payments must be released by 14:00 to arrive the same day.

## 3. Roles

| Role | Who | Can | Cannot |
|---|---|---|---|
| Preparer | Luis Ortega (AP Clerk). Leo Martin (Finance Intern) may prepare under supervision | Build the payment proposal; match invoices | Input or release payments |
| Reviewer and inputter | Grace Adeyemi (AP Specialist) | Review the proposal; input the payment file in the bank portal | Release a payment she input |
| Releaser | Tom Whitfield or Daniel Reyes | Release payments in the bank portal | Release a payment they input |

Interns, contractors and temporary staff never get bank portal access, at any level.

## 4. Approval limits

Each invoice needs approval to pay at the level below, based on its gross amount. Non-GBP amounts are converted at the finance system's daily rate on the run date. These limits come from the delegated authority matrix (version 4, effective 1 January 2026).

| Gross amount of a single invoice or payment | Approver |
|---|---|
| Up to £10,000 | AP Specialist (Grace Adeyemi) |
| £10,000.01 to £50,000 | Financial Controller (Tom Whitfield) |
| £50,000.01 to £250,000 | CFO (Daniel Reyes) |
| Over £250,000 | CFO and CEO (Daniel Reyes and Amara Okafor) |

Approval to pay is separate from approval to spend. The budget holder must already have approved the spend on the purchase order or the invoice.

A run whose total is over £500,000 must be released by the CFO, whatever the size of the individual payments.

## 5. Steps for each run

1. **Match.** By the cut-off, each invoice is matched in NetSuite to its purchase order and goods receipt. If the invoice differs from the PO by more than 2% or £50, whichever is lower, put it on hold and query it with the supplier.
2. **Build the proposal.** At 09:00 on the run day, Luis Ortega runs the AP-Proposal saved search, removes held invoices and checks due dates.
3. **Check for duplicates.** Look for the same invoice number from the same supplier, and for the same supplier and amount within 60 days. Remove anything doubtful.
4. **Review and input.** Grace Adeyemi reviews the proposal, saves it as a PDF in /Finance/AP/Payment runs, and inputs the payment file: Faster Payments for GBP, SEPA credit transfer for EUR. Use CHAPS only for a GBP payment over £1,000,000 or an urgent same-day payment approved by the Financial Controller.
5. **Release.** The releaser checks the bank file total against the proposal and releases it by 14:00. The bank portal enforces dual control: the inputter cannot release.
6. **Remittance.** NetSuite emails remittance advice to suppliers automatically.
7. **Post and reconcile.** Record the bank file reference in NetSuite on the same day. The payments are matched in the next morning's bank reconciliation.

## 6. New suppliers and changes to bank details

Changes to bank details are the most common way fraudsters steal from finance teams. Treat every request as suspicious until it is verified.

- **New suppliers** are set up on form AP-03 with the company number, VAT number and bank details on the supplier's letterhead. AP checks the company at Companies House (or the national register) and screens it against the sanctions lists.
- **Any change to bank details** must be verified by phone. Call the supplier on a number we already hold, never on a number given in the request, and the call must be made by someone other than the person who received the request. Record who you spoke to, when, and on which number.
- **Cooling-off:** new details take effect two working days after verification.
- **Confirmation of Payee:** run it for every new or changed GBP account. If the name does not match, stop and escalate to Tom Whitfield.
- **First payment to new details:** if it is over £10,000, it needs Financial Controller approval even if the amount would otherwise fall in the AP Specialist's band.
- **Email-only requests** to change bank details are reported the same day to Tom Whitfield and to Lena Fischer (Security Engineer), with the original email attached.

## 7. Urgent payments outside a run

Use form AP-07. The Financial Controller must approve the urgency, and the normal limits in section 4 still apply. We aim for no more than two urgent payments a week; Tom Whitfield reviews the list every month.

## 8. Records and checks

- Keep payment proposals, approvals and bank files for 7 years.
- Tom Whitfield reviews the supplier master changes report every month.
- Reconcile supplier statements every month for the top 30 suppliers by spend.
- Missed payments and duplicate payments are logged and reported in the month-end close pack.

## 9. Version history

| Version | Date | Change | By |
|---|---|---|---|
| 2.3 | 2 June 2026 | Added Kestrel Pay Europe Ltd EUR payments by SEPA; added the rule that the CFO releases any run over £500,000 | Grace Adeyemi, approved by Tom Whitfield |
| 2.2 | 14 January 2026 | Limits aligned with the delegated authority matrix effective 1 January 2026; AP Specialist limit raised from £5,000 to £10,000 | Grace Adeyemi, approved by Tom Whitfield |
| 2.1 | 10 March 2025 | Confirmation of Payee check added for new and changed GBP accounts | Grace Adeyemi, approved by Tom Whitfield |
