---
title: The over-fetch filter
type: graded
slots:
  retrieve/acl: acl.ts
---

# The over-fetch filter

👨‍💼 Leo Martin types "Project Heron acquisition of Lumen Ledger board vote". He can't read the Heron documents, and the assistant must not hint that they exist. But "no results" is wrong too: he may read 18 documents, and some of them are about deals, boards and votes. Your `readable()` decides each chunk. Now make sure search hands it the right chunks, and enough of them.

## Terms

- The **pre-filter** is `candidateDocuments`: the documents the viewer's principal set has an `allow` row on. Both searches only look inside them. It's a recall filter, not a decision: cheap, and allowed to be too wide.
- **Over-fetch** is asking for more candidates than you'll return (60 for 8), so the ones the decision refuses still leave enough.
- **The decision** over the candidates is `decideChunks`: one statement that runs `readable()` on every candidate and splits them into allowed (in fused order) and denied.
- `retrieval_audit` keeps one row per search: the chunks returned, the ids denied, and the ACL version it decided at.

## Do this

🐨 This is your step 3 file with two functions taken out for you to write: `candidateDocuments` and `decideChunks`. `retrieve` calls both on every question.

## A worked example

Leo's question, on the test corpus (all 40 Kestrel documents but the filing's chunks, the hashing embedder, the overlap reranker):

| How search runs                                  | Denied   | Leo gets            |
| ------------------------------------------------ | -------- | ------------------- |
| over all 40 documents, decide the top 8          | 8 of 8   | nothing             |
| over all 40 documents, decide the top 60         | 40 of 60 | 8, from the 20 left |
| inside his 18 documents (the pre-filter), top 60 | 0        | 8                   |

Daniel Reyes asks the same thing and gets the memo first.

Now break the cache from step 2: delete Leo's closure rows by hand, so his cached set still says AP, Finance and Kestrel. Search looks in his old 18 documents, 60 candidates come back, and the decision, reading the live closure, refuses all 60. The audit row says so. He gets nothing he may no longer read.

Run the tests with `pnpm ex test 09.4`. They need Postgres (`pnpm ex up`).
