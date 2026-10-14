# Golden set: 2026-10-14 (retrieval-only)

Started 2026-10-14T16:00:09.215Z. Embeddings `text-embedding-3-small@1536`, reranker `cohere/rerank-v4.0-fast`, rewriter `gpt-6-luna (medium)`, answers `not run`. Retrieval at k = 10 (40 per list, 60 candidates, 30 reranked); answers from the first 8.

```
golden set, retrieval-only: 46 questions
gates PASS: leaks [], cross-tenant [], abstentions missed [], errors []
scores PASS: recall@10 1.000 (bar 0.85), MRR 0.931 (bar 0.6), NDCG@10 0.938
answers: not run
cost: $0.0028; embeddings 2614 tokens; rewrites 8728 in / 3817 out; answers 0 in / 0 out; 45 rerank calls
```

## Scores by trap (answer cases)

| Trap | Questions | recall@10 | MRR | NDCG@10 |
|---|---:|---:|---:|---:|
| acl-leak | 6 | 1.000 | 0.792 | 0.825 |
| conflicting-sources | 4 | 1.000 | 0.750 | 0.815 |
| fan-out | 5 | 1.000 | 1.000 | 1.000 |
| lexical | 10 | 1.000 | 1.000 | 0.988 |
| ocr | 7 | 1.000 | 0.929 | 0.943 |
| prompt-injection | 1 | 1.000 | 1.000 | 1.000 |
| tables | 4 | 1.000 | 1.000 | 0.927 |
| tenant-isolation | 3 | 1.000 | 1.000 | 1.000 |
| **all** | 40 | 1.000 | 0.931 | 0.938 |

## Questions

| Question | User | Expect | recall@10 | RR | NDCG@10 | Answer | Gates |
|---|---|---|---:|---:|---:|---|---|
| kpc-2026-0142-owner | kestrel/leo.martin | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kpc-2025-0142-subject | kestrel/ben.carter | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kpc-2026-0412-break | kestrel/maya.levi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kp-4031-retry | kestrel/sam.patel | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kp-9007-wait | kestrel/omar.haddad | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kc-pro-12-price | kestrel/chloe.dubois | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ka-plus-12-billing | kestrel/hannah.kim | answer | 1.000 | 1.000 | 1.000 |  | ok |
| kp-bulk-500-overage | kestrel/jake.morrison | answer | 1.000 | 1.000 | 1.000 |  | ok |
| q3-revenue-by-product | kestrel/mia.chen | answer | 1.000 | 1.000 | 0.832 |  | ok |
| q3-lisbon-headcount | kestrel/mia.chen | answer | 1.000 | 1.000 | 1.000 |  | ok |
| q3-cash | kestrel/chris.dunn | answer | 1.000 | 1.000 | 0.877 |  | ok |
| q3-professional-fees | kestrel/jonas.berg | answer | 1.000 | 1.000 | 1.000 |  | ok |
| expenses-meals | kestrel/leo.martin | answer | 1.000 | 0.500 | 0.631 |  | ok |
| expenses-london-hotel | kestrel/rachel.obi | answer | 1.000 | 0.500 | 0.631 |  | ok |
| expenses-old-policy | kestrel/aisha.rahman | answer | 1.000 | 1.000 | 1.000 |  | ok |
| expenses-receipt-taxi | kestrel/ella.brooks | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-invoice-hold | kestrel/grace.adeyemi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-payment-run | kestrel/luis.ortega | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-msa-received | kestrel/tom.whitfield | answer | 1.000 | 0.500 | 0.631 |  | ok |
| ocr-order-form-total | kestrel/chloe.dubois | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-incident-duplicates | kestrel/kofi.mensah | answer | 1.000 | 1.000 | 0.967 |  | ok |
| ocr-offsite-backfills | kestrel/amara.okafor | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-grievance-asks | kestrel/marco.bianchi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-sg-2025-02 | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-mi-2026-03 | kestrel/ben.carter | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-fos-decision | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-largest-payroll | kestrel/helen.marsh | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-merchant-exit | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| heron-intern | kestrel/leo.martin | abstain |  |  |  |  | ok |
| heron-engineer | kestrel/sam.patel | abstain |  |  |  |  | ok |
| heron-cfo | kestrel/daniel.reyes | answer | 1.000 | 0.500 | 0.645 |  | ok |
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

### expenses-meals

kestrel/leo.martin: How much can I claim a day for meals when I travel for work?

Labels: [0] /HR/Policies/Travel and Expenses Policy v2.pdf p2

Rewrites: "business travel daily meal allowance claim limit", "per diem rates for meals during work travel", "employee travel expense reimbursement meal limits per day"

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.9)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.899) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.784)
4. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.766)
5. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.764)
6. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.672)
7. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.663)
8. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.59)
9. /HR/Policies/Travel and Expenses Policy.pdf p1 (0.529)
10. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.523)

### expenses-london-hotel

kestrel/rachel.obi: What is the nightly limit for a hotel in London?

Labels: [0] /HR/Policies/Travel and Expenses Policy v2.pdf p2

Rewrites: "London hotel nightly rate limit or accommodation cap in the travel expense policy", "maximum allowable hotel cost per night in London; lodging and accommodation reimbursement limits", "business travel hotel nightly spending limit for London"

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.851)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.85) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.836)
4. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.71)
5. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.687)
6. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.42)
7. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.409)
8. /Company/Code of Conduct.pdf p2-3 (0.315)
9. /Company/Code of Conduct.pdf p1 (0.302)
10. /HR/Policies/Travel and Expenses Policy.pdf p1 (0.232)

### ocr-msa-received

kestrel/tom.whitfield: When did Kestrel Legal receive the signed Ashgrove master services agreement?

Labels: [0] /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p3

Rewrites: "Date Kestrel Legal received the executed Ashgrove master services agreement", "Kestrel Legal receipt of signed master services agreement (MSA) for Ashgrove", "Ashgrove signed master services agreement received by Kestrel Legal date"

Top 10:

1. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.919)
2. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2-3 (0.898) finds [0]
3. /Legal/Contracts/Contract Register 2026-09-28.pdf p5 (0.681)
4. /Legal/Contracts/Contract Register 2026-09-28.pdf p6 (0.542)
5. /Exec/Project Heron Integration Plan v0.4.docx (0.455)
6. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.409)
7. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.39)
8. /Legal/Contracts/Contract Register 2026-09-28.pdf p1 (0.315)
9. /Finance/Reports/Q3 2026 Quarterly Report.pdf p3 (0.315)
10. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.302)

### heron-cfo

kestrel/daniel.reyes: What enterprise value is the board asked to approve for Project Heron, and how is the completion cash funded?

Labels: [0] /Exec/Project Heron Board Memo.pdf p1; [1] /Exec/Project Heron Board Memo.pdf p3; [2] /Exec/Exec Offsite Notes Sept 2026.pdf p1

Rewrites: "Project Heron enterprise value submitted for board approval and completion cash funding sources", "Project Heron transaction valuation enterprise value, cash consideration at completion, and funding arrangements", "Board approval request for Project Heron: enterprise value and financing of completion cash"

Top 10:

1. /Exec/Board Pack 2026-07-22.pdf p3 (0.954)
2. /Exec/Project Heron Board Memo.pdf p1 (0.914) finds [0]
3. /Exec/Board Pack 2026-07-22.pdf p3-4 (0.859)
4. /Exec/Project Heron Integration Plan v0.4.docx (0.791)
5. /Exec/Exec Offsite Notes Sept 2026.pdf p1-2 (0.686) finds [2]
6. /Exec/Project Heron Board Memo.pdf p3 (0.6) finds [1]
7. /Exec/Board Pack 2026-07-22.pdf p1 (0.55)
8. /Exec/Project Heron Board Memo.pdf p4-5 (0.548)
9. /Exec/Board Pack 2026-07-22.pdf p2 (0.468)
10. /Exec/Project Heron Board Memo.pdf p1 (0.451)

### fraud-rule-payments

kestrel/lena.fischer: What does Kestrel Shield fraud rule FR-110 do?

Labels: [0] /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2

Rewrites: "Kestrel Shield FR-110 fraud rule description and action", "FR-110 fraud detection rule trigger conditions and response", "Kestrel Shield fraud rule FR-110 purpose behavior"

Top 10:

1. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.865)
2. /Engineering/Runbooks/on-call-runbook.md (0.638)
3. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.615)
4. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.609) finds [0]
5. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.542)
6. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.521)
7. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.496)
8. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2-3 (0.476)
9. /Company/Kestrel Pay Employee Handbook 2026.docx (0.409)
10. /HR/Policies/Travel and Expenses Policy.pdf p2-3 (0.347)

## Usage

- Embeddings: 2614 tokens ($0.00005)
- Query rewrites: 46 calls, 8728 input (0 cached) and 3817 output tokens ($0.00278)
- Answers: 0 calls, 0 input and 0 output tokens, 0 of them reasoning ($0.00000, priced uncached)
- Rerank: 45 calls (a Cohere trial key bills nothing)
- Total: $0.0028
