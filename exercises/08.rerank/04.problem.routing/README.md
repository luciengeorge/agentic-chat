---
title: Document-level routing
type: graded
slots:
  query/route: route.ts
---

# Document-level routing

👨‍💼 Kestrel's corpus is 46 documents and 5,708 chunks, and one document, the FCA filing, holds 5,274 of them. Any word a question uses, the filing probably uses too. Routing is the obvious fix: decide which few documents a question is about, then search inside those only. Build it, then see what it costs.

## Terms

- **Routing** picks the documents first. `retrieve` then searches chunks of only those (`settings.routeDocuments`, 0 by default, which is off). `pnpm eval --route 5` turns it on.
- A **card** stands for one document: its title, its path, and its first chunk with that chunk's vector. `documentCards` (written) makes one for each document the viewer may read.
- **RRF** (reciprocal rank fusion, section 07) adds `1 / (60 + rank)` over every list an item is in, so lists on different scales can be combined by rank alone.

## Do this

🐨 Write `routeDocuments` in `playground/route.ts`: rank the cards by BM25 over their words and by the cosine similarity of their vectors, fuse the two with RRF, and return the first `limit` document ids.

## A worked example

Sofia Lindqvist asks: "Why was merchant M-221449 exited, and what reserve was held?" She may read 15 documents, so routing builds 15 cards. By words, the Delegated Authority Matrix comes first (it has a row about writing off merchant debt). By vector, the Contract Register does. Fused, the top five are the Matrix, the Register, the Compliance Monitoring Report, the Ashgrove MSA and the Leave Policy.

The answer is on page 2,861 of the filing: Harlow Street Fashion Ltd, exited on 15 March 2026, £62,500.00 held. The filing's card is its cover page, title and reporting period, so it ranks 11th by words, 4th by vector, and 8th fused. Searching five documents, retrieval finds nothing that answers.

Run the tests with `pnpm ex test 08.4`. They use the 15 recorded cards, with their real vectors.
