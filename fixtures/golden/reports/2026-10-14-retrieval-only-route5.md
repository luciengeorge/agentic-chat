# Golden set: 2026-10-14 (retrieval-only-route5)

Started 2026-10-14T16:11:15.204Z. Embeddings `text-embedding-3-small@1536`, reranker `cohere/rerank-v4.0-fast`, rewriter `gpt-6-luna (medium)`, answers `not run`. Retrieval at k = 10 (40 per list, 60 candidates, 30 reranked); answers from the first 8. Chunks searched in the first 5 routed documents.

```
golden set, retrieval-only-route5: 46 questions
gates PASS: leaks [], cross-tenant [], abstentions missed [], errors []
scores PASS: recall@10 0.950 (bar 0.85), MRR 0.921 (bar 0.6), NDCG@10 0.906
answers: not run
cost: $0.0027; embeddings 2610 tokens; rewrites 8728 in / 3631 out; answers 0 in / 0 out; 45 rerank calls
```

## Scores by trap (answer cases)

| Trap | Questions | recall@10 | MRR | NDCG@10 |
|---|---:|---:|---:|---:|
| acl-leak | 6 | 0.917 | 0.889 | 0.837 |
| conflicting-sources | 4 | 1.000 | 0.750 | 0.815 |
| fan-out | 5 | 0.700 | 0.800 | 0.723 |
| lexical | 10 | 0.950 | 1.000 | 0.961 |
| ocr | 7 | 1.000 | 0.929 | 0.947 |
| prompt-injection | 1 | 1.000 | 1.000 | 1.000 |
| tables | 4 | 1.000 | 1.000 | 0.927 |
| tenant-isolation | 3 | 1.000 | 1.000 | 1.000 |
| **all** | 40 | 0.950 | 0.921 | 0.906 |

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
| ocr-incident-duplicates | kestrel/kofi.mensah | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-offsite-backfills | kestrel/amara.okafor | answer | 1.000 | 1.000 | 1.000 |  | ok |
| ocr-grievance-asks | kestrel/marco.bianchi | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-sg-2025-02 | kestrel/sofia.lindqvist | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-mi-2026-03 | kestrel/ben.carter | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-fos-decision | kestrel/sofia.lindqvist | answer | 0.500 | 1.000 | 0.613 |  | ok |
| filing-largest-payroll | kestrel/helen.marsh | answer | 1.000 | 1.000 | 1.000 |  | ok |
| filing-merchant-exit | kestrel/sofia.lindqvist | answer | 0.000 | 0.000 | 0.000 |  | ok |
| heron-intern | kestrel/leo.martin | abstain |  |  |  |  | ok |
| heron-engineer | kestrel/sam.patel | abstain |  |  |  |  | ok |
| heron-cfo | kestrel/daniel.reyes | answer | 1.000 | 1.000 | 0.906 |  | ok |
| heron-controller-cost | kestrel/tom.whitfield | answer | 1.000 | 1.000 | 1.000 |  | ok |
| heron-controller-loan | kestrel/tom.whitfield | answer | 1.000 | 1.000 | 1.000 |  | ok |
| nda-restricted-intern | kestrel/leo.martin | answer | 1.000 | 1.000 | 1.000 |  | ok |
| nda-restricted-exec | kestrel/helen.marsh | answer | 0.500 | 1.000 | 0.613 |  | ok |
| fraud-rule-payments | kestrel/lena.fischer | answer | 1.000 | 0.333 | 0.500 |  | ok |
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

Rewrites: "daily meal allowance or per diem limit for business travel", "meal expense reimbursement maximum amount per day during work travel"

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

Rewrites: "London hotel nightly rate limit", "Maximum allowable per-night hotel cost in London", "London lodging cap per night"

Top 10:

1. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.851)
2. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.85) finds [0]
3. /HR/Policies/Travel and Expenses Policy v2.pdf p4 (0.836)
4. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.71)
5. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.687)
6. /HR/Policies/Travel and Expenses Policy.pdf p2 (0.42)
7. /HR/Policies/Travel and Expenses Policy v2.pdf p2 (0.409)
8. /HR/Policies/Travel and Expenses Policy.pdf p1 (0.232)
9. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.232)
10. /HR/Policies/Travel and Expenses Policy v2.pdf p1 (0.19)

### ocr-msa-received

kestrel/tom.whitfield: When did Kestrel Legal receive the signed Ashgrove master services agreement?

Labels: [0] /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p3

Rewrites: "Date Kestrel Legal received the executed Ashgrove master services agreement", "Ashgrove MSA signed agreement delivery or receipt date by Kestrel Legal", "Kestrel Legal receipt of fully signed Ashgrove services contract"

Top 10:

1. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.919)
2. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2-3 (0.898) finds [0]
3. /Legal/Contracts/Contract Register 2026-09-28.pdf p5 (0.681)
4. /Legal/Contracts/Contract Register 2026-09-28.pdf p6 (0.542)
5. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.409)
6. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1 (0.39)
7. /Legal/Contracts/Contract Register 2026-09-28.pdf p1 (0.315)
8. /Finance/Reports/Q3 2026 Quarterly Report.pdf p3 (0.315)
9. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.302)
10. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.296)

### filing-merchant-exit

kestrel/sofia.lindqvist: Why was merchant M-221449 exited, and what reserve was held?

Labels: [0] /Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf p2861

Rewrites: "merchant M-221449 reason for exit and reserve held", "M-221449 merchant termination or offboarding rationale and reserve amount", "M-221449 exit decision, risk basis, and funds withheld or rolling reserve details"

Top 10:

1. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p2 (0.176)
2. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.159)
3. /Legal/Delegated Authority Matrix 2026.pdf p2 (0.147)
4. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.147)
5. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p2 (0.136)
6. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.136)
7. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.123)
8. /Legal/Contracts/Contract Register 2026-09-28.pdf p4 (0.112)
9. /Legal/Regulatory/Compliance Monitoring Report Q2 2026.pdf p3 (0.109)
10. /Legal/Contracts/KPC-2026-0142 Ashgrove MSA (executed).pdf p1-2 (0.106)

### fraud-rule-payments

kestrel/lena.fischer: What does Kestrel Shield fraud rule FR-110 do?

Labels: [0] /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2

Rewrites: "Kestrel Shield fraud rule FR-110 description and actions", "FR-110 fraud detection rule triggers, criteria, and response", "Kestrel Shield FR-110 rule policy documentation"

Top 10:

1. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.865)
2. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p1 (0.615)
3. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.609) finds [0]
4. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.542)
5. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2-3 (0.476)
6. /Company/Kestrel Pay Employee Handbook 2026.docx (0.409)
7. /Company/Code of Conduct.pdf p1 (0.343)
8. /Engineering/Runbooks/Kestrel Shield Fraud Rules v14.pdf p2 (0.289)
9. /Company/Code of Conduct.pdf p1 (0.273)
10. /Company/Code of Conduct.pdf p1 (0.264)

## Usage

- Embeddings: 2610 tokens ($0.00005)
- Query rewrites: 46 calls, 8728 input (0 cached) and 3631 output tokens ($0.00269)
- Answers: 0 calls, 0 input and 0 output tokens, 0 of them reasoning ($0.00000, priced uncached)
- Rerank: 45 calls (a Cohere trial key bills nothing)
- Total: $0.0027
