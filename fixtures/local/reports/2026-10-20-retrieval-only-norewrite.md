# Golden set: 2026-10-20 (retrieval-only-norewrite)

Started 2026-10-20T20:42:53.402Z. Embeddings `text-embedding-3-small@1536`, reranker `cohere/rerank-v4.0-fast`, rewriter `null`, answers `not run`. Retrieval at k = 10 (40 per list, 60 candidates, 30 reranked); answers from the first 8.

```
golden set, retrieval-only-norewrite: 46 questions
gates PASS: leaks [], cross-tenant [], abstentions missed [], errors []
scores PASS: recall@10 1.000 (bar 0.85), MRR 0.944 (bar 0.6), NDCG@10 0.947
answers: not run
cost: $0.0000; embeddings 824 tokens; rewrites 0 in / 0 out; answers 0 in / 0 out; 45 rerank calls
```

## Scores by trap (answer cases)

| Trap | Questions | recall@10 | MRR | NDCG@10 |
|---|---:|---:|---:|---:|
| acl-leak | 6 | 1.000 | 0.792 | 0.825 |
| conflicting-sources | 4 | 1.000 | 0.875 | 0.908 |
| fan-out | 5 | 1.000 | 1.000 | 1.000 |
| lexical | 10 | 1.000 | 1.000 | 0.988 |
| ocr | 7 | 1.000 | 0.929 | 0.943 |
| prompt-injection | 1 | 1.000 | 1.000 | 1.000 |
| tables | 4 | 1.000 | 1.000 | 0.927 |
| tenant-isolation | 3 | 1.000 | 1.000 | 1.000 |
| **all** | 40 | 1.000 | 0.944 | 0.947 |

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
| expenses-london-hotel | kestrel/rachel.obi | answer | 1.000 | 1.000 | 1.000 |  | ok |
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

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.9)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.899) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.785)
4. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.764)
5. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.762)
6. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.672)
7. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.662)
8. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.589)
9. /HR/Policies/Travel and Expenses Policy.pdf p1 (0.529)
10. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.523)

### ocr-msa-received

kestrel/tom.whitfield: When did Kestrel Legal receive the signed Ashgrove master services agreement?

Labels: [0] /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p3

Top 10:

1. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.918)
2. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2-3 (0.898) finds [0]
3. /Legal/Contracts/Contract Register 2026-09-28.pdf p5 (0.677)
4. /Legal/Contracts/Contract Register 2026-09-28.pdf p6 (0.541)
5. /Exec/Project Heron Integration Plan v0.4.docx (0.451)
6. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.409)
7. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.386)
8. /Legal/Contracts/Contract Register 2026-09-28.pdf p1 (0.312)
9. /Finance/Reports/Q3 2026 Quarterly Report.pdf p3 (0.312)
10. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.299)

### heron-cfo

kestrel/daniel.reyes: What enterprise value is the board asked to approve for Project Heron, and how is the completion cash funded?

Labels: [0] /Exec/Project Heron Board Memo.pdf p1; [1] /Exec/Project Heron Board Memo.pdf p3; [2] /Exec/Exec Offsite Notes Sept 2026.pdf p1

Top 10:

1. /Exec/Board Pack 2026-07-22.pdf p3 (0.954)
2. /Exec/Project Heron Board Memo.pdf p1 (0.914) finds [0]
3. /Exec/Board Pack 2026-07-22.pdf p3-4 (0.859)
4. /Exec/Project Heron Integration Plan v0.4.docx (0.792)
5. /Exec/Exec Offsite Notes Sept 2026.pdf p1-2 (0.684) finds [2]
6. /Exec/Project Heron Board Memo.pdf p3 (0.604) finds [1]
7. /Exec/Board Pack 2026-07-22.pdf p1 (0.554)
8. /Exec/Project Heron Board Memo.pdf p4-5 (0.546)
9. /Exec/Board Pack 2026-07-22.pdf p2 (0.466)
10. /Exec/Project Heron Board Memo.pdf p1 (0.451)

### fraud-rule-payments

kestrel/lena.fischer: What does Kestrel Shield fraud rule FR-110 do?

Labels: [0] /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2

Top 10:

1. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.865)
2. /Engineering/Runbooks/on-call-runbook.md (0.638)
3. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.617)
4. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.611) finds [0]
5. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.544)
6. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.523)
7. /Engineering/Runbooks/Payments API Error Code Catalogue.pdf p3 (0.496)
8. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2-3 (0.478)
9. /Company/Kestrel Pay Employee Handbook 2026.docx (0.409)
10. /HR/Policies/Travel and Expenses Policy.pdf p2-3 (0.347)

## Usage

- Embeddings: 824 tokens ($0.00002)
- Query rewrites: 0 calls, 0 input (0 cached) and 0 output tokens ($0.00000)
- Answers: 0 calls, 0 input and 0 output tokens, 0 of them reasoning ($0.00000, priced uncached)
- Rerank: 45 calls (a Cohere trial key bills nothing)
- Total: $0.0000
