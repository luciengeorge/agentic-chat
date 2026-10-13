---
id: legal-contract-kpc-2025-0231-sorrel-dpa
title: "KPC-2025-0231 Data Processing Agreement: Sorrel Identity"
folder: /Legal/Contracts
filename: KPC-2025-0231 Sorrel Identity DPA.docx
format: docx
author: ben.carter
created: 2025-11-05
modified: 2025-11-05
---

# Data processing agreement

**Contract number KPC-2025-0231.** This agreement supplements the Identity Verification Services Agreement between the same parties, contract number KPC-2025-0230 (the "Services Agreement").

| Party | Details | Role |
|---|---|---|
| Kestrel Pay Ltd | Company number 10873215, 12 Harrow Yard, London EC2A 4PN | Controller |
| Sorrel Identity Ltd | Company number 09817342, 21 Wellington Place, Leeds LS1 4AP | Processor |

Dated 4 November 2025. Effective from 15 November 2025, the start date of the Services Agreement. Governed by the UK GDPR and the Data Protection Act 2018.

## 1. Subject matter and duration

1.1 Sorrel processes personal data to verify the identity of the directors, beneficial owners and authorised users of businesses that apply to become Kestrel merchants, and to screen them against sanctions and politically exposed person (PEP) lists.

1.2 This agreement lasts as long as the Services Agreement, and clauses 10 and 11 survive its end.

## 2. Instructions

2.1 Sorrel processes Kestrel personal data only on Kestrel's documented instructions. Those instructions are the service description in Annex 1 and the API requests Kestrel sends.

2.2 Sorrel will tell Kestrel at once if it thinks an instruction breaks data protection law, and may pause that processing until Kestrel confirms or changes the instruction.

## 3. What is processed (Annex 1)

| Item | Detail |
|---|---|
| Data subjects | Directors, beneficial owners and authorised users of merchant applicants and merchants |
| Personal data | Name, date of birth, home address, nationality, ID document number and images, selfie video, IP address and device data captured during the check |
| Special category data | Biometric data (face templates) used only to match the selfie to the ID document |
| Purpose | Customer due diligence under the Money Laundering Regulations 2017; sanctions screening |
| Kestrel's lawful basis | Legal obligation; for biometric data, the substantial public interest condition for preventing or detecting unlawful acts in Schedule 1 of the Data Protection Act 2018 |
| Volume | About 5,000 checks a month |

## 4. Retention by Sorrel

| Data | How long Sorrel keeps it |
|---|---|
| ID document images and selfie video | 30 days after the check, then deleted |
| Biometric face templates | Deleted as soon as the match result is returned, and never kept longer than 24 hours |
| Check results, extracted document fields and audit log | Returned to Kestrel; Sorrel keeps a copy for 90 days for support, then deletes it |
| Sanctions and PEP screening results | Returned to Kestrel; Sorrel keeps a copy for 90 days |

Kestrel keeps check and screening results for 5 years after the end of the business relationship, as the Money Laundering Regulations require. That retention is Kestrel's responsibility as controller.

<!-- pagebreak -->

## 5. Security

5.1 Sorrel will keep ISO 27001 certification for the services and give Kestrel its SOC 2 Type II report once a year.

5.2 Personal data is encrypted at rest (AES-256) and in transit (TLS 1.2 or higher). Sorrel hosts the service in the AWS eu-west-2 (London) region.

5.3 Only named Sorrel staff with a need may access Kestrel data, and every access is logged. Sorrel runs an external penetration test each year and sends Kestrel a summary of findings within 30 days.

## 6. Sub-processors

6.1 Kestrel approves the sub-processors below.

| Sub-processor | Service | Location | Transfer safeguard |
|---|---|---|---|
| Amazon Web Services EMEA SARL | Hosting in the AWS eu-west-2 (London) region | United Kingdom | None needed |
| Lantern Screening B.V. | Sanctions and PEP list screening | Netherlands | UK adequacy regulations for the EEA |
| Kittle Labs Inc. | Support for the liveness detection model; sees images only for escalated cases, no more than 50 a month | United States | UK International Data Transfer Addendum to the EU standard contractual clauses; transfer risk assessment dated 20 October 2025 |

6.2 Sorrel will give Kestrel at least 30 days' written notice before adding or replacing a sub-processor. Kestrel may object on reasonable grounds. If the parties cannot agree within 30 days, Kestrel may end the affected services without paying any termination charge.

6.3 Sorrel stays fully liable to Kestrel for the acts of its sub-processors.

## 7. Personal data breaches

7.1 Sorrel will notify Kestrel of any personal data breach without undue delay, and in any case **within 24 hours** of becoming aware of it, by email to privacy@kestrelpay.example and by phone to Kestrel's security on-call number.

7.2 Within 72 hours Sorrel will send what it knows of the nature of the breach, the data and people affected, the likely consequences and the steps taken.

7.3 Kestrel decides whether to notify the Information Commissioner's Office and the people affected. Sorrel will not notify anyone about a breach of Kestrel data without Kestrel's agreement, unless the law requires it.

## 8. Data subject rights

Sorrel will pass any request from a data subject to Kestrel within 2 business days and will not answer it directly. Sorrel will help Kestrel respond within the time limits in the UK GDPR.

## 9. Audits

9.1 Kestrel, or an auditor it appoints, may audit Sorrel's compliance with this agreement once in each contract year on 30 days' notice, and at any time after a personal data breach.

9.2 Sorrel will give the FCA and the ICO any access they ask for.

## 10. Return and deletion

When the Services Agreement ends, Sorrel will delete all Kestrel personal data within 30 days, unless the law requires it to keep some, and will send a written certificate of deletion signed by its Data Protection Officer.

## 11. Liability

Liability under this agreement follows clause 12 of the Services Agreement, except that each party's total liability for breaches of this agreement is limited to £2,000,000 in each contract year.

## 12. Contacts

| | Kestrel Pay Ltd | Sorrel Identity Ltd |
|---|---|---|
| Privacy contact | privacy@kestrelpay.example | dpo@sorrel-identity.example (Gareth Lyle, Data Protection Officer) |
| Contract owner | Julia Novak, Payments Product Manager | Account director, Sorrel Identity |
| Legal | Ben Carter, Commercial Counsel | Legal team, Sorrel Identity |

## Signatures

| Signed for Kestrel Pay Ltd | Signed for Sorrel Identity Ltd |
|---|---|
| Helen Marsh, General Counsel | Olivia Grant, Chief Executive Officer |
| 4 November 2025 | 4 November 2025 |
