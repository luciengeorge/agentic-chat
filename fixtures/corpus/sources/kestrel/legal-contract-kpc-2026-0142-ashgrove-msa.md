---
id: legal-contract-kpc-2026-0142-ashgrove-msa
title: "KPC-2026-0142 Master Services Agreement: Ashgrove Cloud Services (executed)"
folder: /Legal/Contracts
filename: KPC-2026-0142 Ashgrove MSA (executed).pdf
format: pdf_mixed
author: ben.carter
created: 2026-03-19
modified: 2026-03-19
traps: [ocr]
---

# Master Services Agreement

**Contract number KPC-2026-0142**

Between **Kestrel Pay Ltd**, company number 10873215, of 12 Harrow Yard, London EC2A 4PN ("Kestrel"), and **Ashgrove Cloud Services Ltd**, company number 08215573, of 4 Foundry Lane, Manchester M4 6BX ("Ashgrove").

This executed copy holds clauses 1 to 14 and the signed signature page. Schedules 1 to 4 are filed with it in the contract system.

| Summary | Detail |
|---|---|
| Kestrel owner | Nadia Kowalski, Platform Engineering Lead |
| Commencement Date | 1 April 2026 |
| Initial term ends | 31 March 2029 |
| Renewal | Automatic, for 12 months at a time |
| Notice to stop a renewal | At least 90 days before the end of the current term (for the first renewal, by 31 December 2028) |
| Committed charges | £61,400 a month; £2,210,400 over the initial term |

## 1. Definitions

"Services" means the services in Schedule 1. "Production Environment" means the AWS clusters and databases that run Kestrel's live payments platform. "Regulator" means the FCA or any other authority with power over Kestrel.

## 2. Term

2.1 This agreement starts on 1 April 2026 (the "Commencement Date") and runs for an initial term of 36 months, ending on 31 March 2029.

2.2 It then renews automatically for 12 months at a time, unless either party gives at least 90 days' written notice before the end of the current term.

## 3. Services

3.1 Ashgrove will resell to Kestrel the AWS capacity in Schedule 1 and run Kestrel's AWS production environment (EKS clusters, Aurora PostgreSQL and Kafka) with 24/7 support.

3.2 The Services run in the AWS eu-west-2 (London) region, with disaster recovery in eu-west-1 (Dublin). Ashgrove will not store or process Kestrel data in any other region without Kestrel's prior written consent.

## 4. Charges

4.1 Kestrel will pay a fixed platform fee of £61,400 a month, excluding VAT, invoiced monthly in advance. The fee covers the committed AWS capacity and the managed service set out in Schedule 2.

4.2 Use above the committed capacity is charged monthly in arrears at the rates in Schedule 2.

4.3 From 1 April 2027, and on each 1 April after that, Ashgrove may increase the platform fee by the UK CPI rate for the previous January, up to a maximum of 4%.

4.4 Kestrel will pay valid invoices within 30 days and may withhold any amount it disputes in good faith.

## 5. Service levels

5.1 The Production Environment will be available at least 99.95% of each month. Priority 1 incidents get a response within 15 minutes, 24 hours a day.

5.2 For each 0.1% of availability below the target in a month, Kestrel gets a service credit of 5% of that month's platform fee, up to 25% of the fee.

5.3 Kestrel may terminate under clause 10.3 if availability falls below 99.5% in any two consecutive months, or in any three months within a 12-month period.

## 6. Security

Ashgrove will keep ISO 27001 certification and its PCI DSS Level 1 service provider attestation, send Kestrel its SOC 2 Type II report every year, and report any security incident affecting Kestrel within 24 hours of becoming aware of it.

## 7. Data protection

Ashgrove processes personal data only as Kestrel's processor, under the data processing agreement in Schedule 4 (logged as KPC-2026-0143).

## 8. Audit and regulator access

Kestrel may audit Ashgrove once a year on 30 days' notice, and after any security incident. Any Regulator gets the access to premises, people and records it requires.

## 9. Liability

Each party's total liability in a contract year is limited to 150% of the charges paid or payable in the previous 12 months. Liability for breach of clause 7 or of confidentiality is limited separately to £5,000,000. Nothing limits liability for fraud, death or personal injury.

## 10. Termination

10.1 Kestrel may terminate for convenience on 6 months' written notice given on or after 1 October 2027 (18 months after the Commencement Date). It must then pay an early termination fee equal to 50% of the platform fees that would have been payable for the rest of the initial term.

10.2 Either party may terminate if the other commits a material breach and does not remedy it within 30 days of notice, or becomes insolvent.

10.3 Kestrel may terminate without paying an early termination fee under clause 5.3, or if a Regulator directs it to end the arrangement.

## 11. Exit

On expiry or termination, Ashgrove will give up to 6 months of exit assistance at the Schedule 2 rates, return all Kestrel data in standard formats, and delete it within 30 days after the exit period ends.

## 12. Subcontracting

Ashgrove may not subcontract any part of the Production Environment services without Kestrel's prior written consent, except to Amazon Web Services EMEA SARL as the underlying cloud provider.

## 13. Disputes and notices

Disputes go to the Kestrel owner and Ashgrove's account director, then to Kestrel's CTO and Ashgrove's CEO. Notices go to legal@kestrelpay.example and contracts@ashgrove-cloud.example.

## 14. Governing law

The law of England and Wales governs this agreement; the English courts have exclusive jurisdiction.

<!-- scan-begin -->

## Signature page

**KPC-2026-0142: Master Services Agreement between Kestrel Pay Ltd and Ashgrove Cloud Services Ltd**

This agreement takes effect on the date of the last signature below. The Services start on the Commencement Date in clause 2.1.

| Signed for and on behalf of Kestrel Pay Ltd | |
|---|---|
| Signature | *Priya Nair* |
| Name | Priya Nair |
| Title | Chief Technology Officer |
| Date | 17 March 2026 |

| Signed for and on behalf of Kestrel Pay Ltd | |
|---|---|
| Signature | *D. Reyes* |
| Name | Daniel Reyes |
| Title | Chief Financial Officer |
| Date | 17 March 2026 |

| Signed for and on behalf of Ashgrove Cloud Services Ltd | |
|---|---|
| Signature | *M. Kell* |
| Name | Martin Kell |
| Title | Chief Commercial Officer |
| Date | 18 March 2026 |

RECEIVED BY KESTREL LEGAL 19 MAR 2026. Logged as KPC-2026-0142. ML

<!-- scan-end -->
