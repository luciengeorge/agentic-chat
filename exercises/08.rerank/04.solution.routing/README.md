---
title: Document-level routing
type: graded
slots:
  query/route: route.ts
---

# Document-level routing: the solution

`routeDocuments` throws a `RangeError` for a limit that isn't a whole number from 1. It builds a BM25 index over `${title}\n${path}\n${text}` for every card and searches it with the question. It takes the cards that have a vector, scores each by `cosine(questionEmbedding, card.embedding)`, and sorts them highest first. It fuses the two id lists with `rrf` and returns the first `limit`.

## Why it works

- **Two views of a document.** The title and path carry exact names ("Contract Register", "Leave Policy"); the first chunk's vector carries what it's about in any words. A card high in both is almost surely the document.
- **Rank, not score.** BM25 scores run from 0 to about 5 here, cosines from 0.12 to 0.29. RRF only looks at the order, so neither has to be scaled to the other.
- **A card without a vector still counts.** A document embedded by another model has no comparable vector, but its title and text still reach BM25.
- **It never sees a document the viewer can't read.** The cards come from the same `readable()` rule as the final decision, so routing can't pick a hidden document, or hint that one exists.

## The worked example, and why it doesn't win here

Sofia's merchant question: 15 cards; the filing's is 11th by BM25 (its cover has none of "merchant", "exited" or "reserve"), 4th by cosine (0.242, behind the Register's 0.294), 8th fused. With five documents routed, the answer on page 2,861 is never searched. In the eval, `--route 5` scored recall@10 0.950 against the default's 1.000: this question found nothing, and two others (the Ombudsman decision and the restricted NDA for Helen Marsh) each lost a label because their second document wasn't routed.

Routing loses here because one card can't describe a 3,000-page document, and because chunk search with fusion and a reranker already copes with the filing's size: the filing's pages only win when they answer.

It wins when there are many documents, each about one thing, and a question names its document: thousands of contracts, each a few pages, where "the termination clause in the Ashgrove MSA" should only search the Ashgrove MSA. It also cuts cost when chunk search is the expensive part. Cards that summarise the whole document (a model-written summary, or the section headings) would help the big ones, at a price per document.
