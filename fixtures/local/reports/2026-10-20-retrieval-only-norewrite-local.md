# Golden set: 2026-10-20 (retrieval-only-norewrite-local)

Started 2026-10-20T20:56:59.489Z. Embeddings `text-embedding-nomic-embed-text-v1.5@768`, reranker `local/Xenova/bge-reranker-base@q8`, rewriter `null`, answers `not run`. Retrieval at k = 10 (40 per list, 60 candidates, 30 reranked); answers from the first 8.

```
golden set, retrieval-only-norewrite-local: 46 questions
gates PASS: leaks [], cross-tenant [], abstentions missed [], errors []
scores PASS: recall@10 1.000 (bar 0.85), MRR 0.887 (bar 0.6), NDCG@10 0.900
answers: not run
cost: $0.0000; embeddings 0 tokens; rewrites 0 in / 0 out; answers 0 in / 0 out; 45 rerank calls
```

## Scores by trap (answer cases)

| Trap | Questions | recall@10 | MRR | NDCG@10 |
|---|---:|---:|---:|---:|
| acl-leak | 6 | 1.000 | 0.792 | 0.818 |
| conflicting-sources | 4 | 1.000 | 0.750 | 0.778 |
| fan-out | 5 | 1.000 | 0.900 | 0.926 |
| lexical | 10 | 1.000 | 0.875 | 0.874 |
| ocr | 7 | 1.000 | 0.929 | 0.957 |
| prompt-injection | 1 | 1.000 | 1.000 | 1.000 |
| tables | 4 | 1.000 | 1.000 | 0.948 |
| tenant-isolation | 3 | 1.000 | 1.000 | 1.000 |
| **all** | 40 | 1.000 | 0.887 | 0.900 |

## Questions

| Question | User | Expect | recall@10 | RR | NDCG@10 | Answer | Gates |
|---|---|---|---:|---:|---:|---|---|
| kpc-2026-0142-owner | kestrel/leo.martin | answer | 1.000 | 1.000 | 0.920 |  | ok |
| kpc-2025-0142-subject | kestrel/ben.carter | answer | 1.000 | 0.250 | 0.431 |  | ok |
| kpc-2026-0412-break | kestrel/maya.levi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kp-4031-retry | kestrel/sam.patel | answer | 1.000 | 0.500 | 0.631 |  | ok |
| kp-9007-wait | kestrel/omar.haddad | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kc-pro-12-price | kestrel/chloe.dubois | answer | 1.000 | 1.000 | 0.877 |  | ok |
| ka-plus-12-billing | kestrel/hannah.kim | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kp-bulk-500-overage | kestrel/jake.morrison | answer | 1.000 | 1.000 | 1.000 |  | ok |
| q3-revenue-by-product | kestrel/mia.chen | answer | 1.000 | 1.000 | 0.790 |  | ok |
| q3-lisbon-headcount | kestrel/mia.chen | answer | 1.000 | 1.000 | 1.000 |  | ok |
| q3-cash | kestrel/chris.dunn | answer | 1.000 | 1.000 | 1.000 |  | ok |
| q3-professional-fees | kestrel/jonas.berg | answer | 1.000 | 1.000 | 1.000 |  | ok |
| expenses-meals | kestrel/leo.martin | answer | 1.000 | 0.500 | 0.631 |  | ok |
| expenses-london-hotel | kestrel/rachel.obi | answer | 1.000 | 0.500 | 0.631 |  | ok |
| expenses-old-policy | kestrel/aisha.rahman | answer | 1.000 | 1.000 | 0.850 |  | ok |
| expenses-receipt-taxi | kestrel/ella.brooks | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-invoice-hold | kestrel/grace.adeyemi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-payment-run | kestrel/luis.ortega | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-msa-received | kestrel/tom.whitfield | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-order-form-total | kestrel/chloe.dubois | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-incident-duplicates | kestrel/kofi.mensah | answer | 1.000 | 0.500 | 0.698 |  | ok |
| ocr-offsite-backfills | kestrel/amara.okafor | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-grievance-asks | kestrel/marco.bianchi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-sg-2025-02 | kestrel/sofia.lindqvist | answer | 1.000 | 0.500 | 0.631 |  | ok |
| filing-mi-2026-03 | kestrel/ben.carter | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-fos-decision | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-largest-payroll | kestrel/helen.marsh | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-merchant-exit | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| heron-intern | kestrel/leo.martin | abstain |  |  |  |  | ok |
| heron-engineer | kestrel/sam.patel | abstain |  |  |  |  | ok |
| heron-cfo | kestrel/daniel.reyes | answer | 1.000 | 0.500 | 0.599 |  | ok |
| heron-controller-cost | kestrel/tom.whitfield | answer | 1.000 | 1.000 | 1.000 |  | ok |
| heron-controller-loan | kestrel/tom.whitfield | answer | 1.000 | 1.000 | 1.000 |  | ok |
| nda-restricted-intern | kestrel/leo.martin | answer | 1.000 | 1.000 | 1.000 |  | ok |
| nda-restricted-exec | kestrel/helen.marsh | answer | 1.000 | 1.000 | 0.877 |  | ok |
| fraud-rule-payments | kestrel/lena.fischer | answer | 1.000 | 0.250 | 0.431 |  | ok |
| fraud-rule-platform | kestrel/sam.patel | abstain |  |  |  |  | ok |
| grievance-hr-partner | kestrel/rachel.obi | abstain |  |  |  |  | ok |
| brightwell-go-live | kestrel/ella.brooks | answer | 1.000 | 1.000 | 1.000 |  | ok |
| harbour-meals | harbour/sam.patel | answer | 1.000 | 1.000 | 1.000 |  | ok |
| harbour-hotel | harbour/nina.osei | answer | 1.000 | 1.000 | 1.000 |  | ok |
| harbour-purchase-approval | harbour/fatima.ali | answer | 1.000 | 1.000 | 1.000 |  | ok |
| harbour-asks-kestrel | harbour/nina.osei | abstain |  |  |  |  | ok |
| disabled-user | kestrel/peter.hall | abstain |  |  |  |  | ok |
| leave-london | kestrel/ella.brooks | answer | 1.000 | 1.000 | 1.000 |  | ok |
| deploy-freeze | kestrel/kofi.mensah | answer | 1.000 | 1.000 | 1.000 |  | ok |

## Misses

Every question with a gate hit, an error, a label missing from the top 10 or not at rank 1, or a failed or flagged answer.

### kpc-2025-0142-subject

kestrel/ben.carter: What is contract KPC-2025-0142 for, and who is the counterparty?

Labels: [0] /Legal/Contracts/Contract Register 2026-09-28.pdf p4

Top 10:

1. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.986)
2. /Legal/Contracts/Contract Register 2026-09-28.pdf p6 (0.926)
3. /Legal/Contracts/Contract Register 2026-09-28.pdf p1 (0.885)
4. /Legal/Contracts/Contract Register 2026-09-28.pdf p4 (0.858) finds [0]
5. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2-3 (0.815)
6. /Legal/Contracts/Contract Register 2026-09-28.pdf p5 (0.813)
7. /Legal/Contracts/Contract Register 2026-09-28.pdf p5 (0.304)
8. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.265)
9. /Legal/Contracts/Contract Register 2026-09-28.pdf p2 (0.213)
10. /Legal/Contracts/Contract Register 2026-09-28.pdf p3 (0.112)

### kp-4031-retry

kestrel/sam.patel: What does error KP-4031 mean, and how should the payment be retried?

Labels: [0] /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3

Top 10:

1. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p1 (0.808)
2. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.691) finds [0]
3. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.43)
4. /Engineering/Runbooks/on-call-runbook.md (0.137)
5. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p1 (0.028)
6. /Engineering/architecture-overview.md (0.02)
7. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p4 (0.017)
8. /Engineering/architecture-overview.md (0.016)
9. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p4 (0.003)
10. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p2 (0.002)

### expenses-meals

kestrel/leo.martin: How much can I claim a day for meals when I travel for work?

Labels: [0] /HR/Policies/Travel and Expenses Policy v2.pdf p2

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.841)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.818) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.69)
4. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.67)
5. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.46)
6. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.268)
7. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.253)
8. /HR/Policies/Travel and Expenses Policy v2.pdf p3 (0.028)
9. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.027)
10. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.017)

### expenses-london-hotel

kestrel/rachel.obi: What is the nightly limit for a hotel in London?

Labels: [0] /HR/Policies/Travel and Expenses Policy v2.pdf p2

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.976)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.959) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.844)
4. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.77)
5. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.667)
6. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.236)
7. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.142)
8. /Company/Code of Conduct.pdf p2-3 (0.029)
9. /Company/Code of Conduct.pdf p1 (0.012)
10. /HR/Policies/Travel and Expenses Policy.pdf p1 (0.006)

### ocr-incident-duplicates

kestrel/kofi.mensah: How many duplicate authorisations did incident INC-2026-0817 cause, and how were they dealt with?

Labels: [0] /Engineering/Incidents/INC-2026-0817 Bridge Notes.pdf p1; [1] /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p1; [2] /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p2

Top 10:

1. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p4 (0.967)
2. /Engineering/Incidents/INC-2026-0817 Bridge Notes.pdf p1-2 (0.682) finds [0]
3. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p2 (0.673) finds [2]
4. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p3 (0.483)
5. /Engineering/Runbooks/deploy-runbook.md (0.446)
6. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p1 (0.261) finds [1]
7. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p1-2 (0.215)
8. /Engineering/Runbooks/on-call-runbook.md (0.095)
9. /Engineering/architecture-overview.md (0.019)
10. /Engineering/Incidents/INC-2026-0817 Postmortem.pdf p2 (0.012)

### filing-sg-2025-02

kestrel/sofia.lindqvist: What caused safeguarding breach SG-2025-02, and when was it reported to the FCA?

Labels: [0] /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p130

Top 10:

1. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p328 (0.974)
2. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p130 (0.962) finds [0]
3. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p869 (0.517)
4. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p32 (0.435)
5. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p1-2 (0.324)
6. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p1 (0.232)
7. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p8 (0.177)
8. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.152)
9. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.038)
10. /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p31 (0.023)

### heron-cfo

kestrel/daniel.reyes: What enterprise value is the board asked to approve for Project Heron, and how is the completion cash funded?

Labels: [0] /Exec/Project Heron Board Memo.pdf p1; [1] /Exec/Project Heron Board Memo.pdf p3; [2] /Exec/Exec Offsite Notes Sept 2026.pdf p1

Top 10:

1. /Exec/Board Pack 2026-07-22.pdf p3 (0.999)
2. /Exec/Project Heron Board Memo.pdf p1 (0.991) finds [0]
3. /Exec/Board Pack 2026-07-22.pdf p3-4 (0.969)
4. /Exec/Board Pack 2026-07-22.pdf p2 (0.67)
5. /Exec/Project Heron Integration Plan v0.4.docx (0.586)
6. /Exec/Project Heron Board Memo.pdf p3 (0.534) finds [1]
7. /Company/Brightwell Payroll Partner Onboarding Pack v1.3.docx (0.282)
8. /Exec/Project Heron Board Memo.pdf p4-5 (0.22)
9. /Exec/Project Heron Board Memo.pdf p1 (0.043)
10. /Exec/Exec Offsite Notes Sept 2026.pdf p1-2 (0.025) finds [2]

### fraud-rule-payments

kestrel/lena.fischer: What does Kestrel Shield fraud rule FR-110 do?

Labels: [0] /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2

Top 10:

1. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.975)
2. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.351)
3. /Engineering/Runbooks/on-call-runbook.md (0.195)
4. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.187) finds [0]
5. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.121)
6. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.086)
7. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.086)
8. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2-3 (0.036)
9. /Company/Kestrel Pay Employee Handbook 2026.docx (0.013)
10. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p4 (0.002)

## Usage

- Embeddings: 0 tokens ($0.00000)
- Query rewrites: 0 calls, 0 input (0 cached) and 0 output tokens ($0.00000)
- Answers: 0 calls, 0 input and 0 output tokens, 0 of them reasoning ($0.00000, priced uncached)
- Rerank: 45 calls (a Cohere trial key bills nothing)
- Total: $0.0000
