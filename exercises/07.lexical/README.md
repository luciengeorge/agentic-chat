---
title: Lexical and hybrid search
---

# Lexical and hybrid search

Ask the assistant about KPC-2026-0142 and the vector search of section 06 brings back the contract register: a chunk about contracts in general, nearest in meaning. It doesn't care which contract. An embedding turns a contract number into "something like a contract number", so KPC-2026-0142 and KPC-2026-0298 land in the same place. For identifiers, error codes and product codes, Kestrel needs search by the exact words. This section builds that half of search, then joins the two halves into one ranking.

## Terms

- **Lexical search** finds documents by the words they contain, where vector search finds them by meaning.
- A **term** is a word as the index stores it, after a **tokenizer** has cut the text into pieces and normalised them (lowercased, maybe **stemmed**: "nightly" cut back to "night").
- **BM25** is the standard formula for ranking documents by a query's terms. A document scores higher when a term appears in it often (**term frequency**, tf), when that term is rare across all documents (**inverse document frequency**, idf), and when the document is short (**length normalisation**).
- **pg_search** is ParadeDB's Postgres extension that adds a BM25 index (built on Tantivy, a Rust search library).
- **Hybrid search** runs both searches and merges their lists. **RRF** (reciprocal rank fusion) merges by rank: each document scores `1 / (60 + rank)` from each list it's in.

## The data

As in section 06, the tests use the recording in `fixtures/vectors/recording/`: the 434 chunks outside the filing, with their text and real embeddings, and the golden questions with theirs, plus three bare identifiers (`KPC-2026-0142`, `KP-4031`, `KPC-2026-0298`) embedded once for this section.

## The steps

1. **BM25 by hand** (`bm25.ts`). The formula, one piece at a time, checked against pg_search's own scores.
2. **The pg_search index** (`lexical.ts`). The app's lexical search: its tokenizer, its scoring, and the ACL pre-filter.
3. **Identifiers** (`bm25.ts`). Explain a score term by term, and see why BM25 finds KPC-2026-0142 where vectors can't.
4. **Changing a tokenizer without downtime** (`reindex.ts`). Swap how the index cuts words while searches keep running.
5. **RRF** (`rrf.ts`). One ranking out of two, using ranks alone.

The lab, `/labs/lexical`, shows the BM25, vector and fused rankings side by side for one question, as the viewer sees them.
