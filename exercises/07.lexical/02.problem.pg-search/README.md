---
title: The pg_search index
type: graded
slots:
  search/lexical: lexical.ts
---

# The pg_search index

👨‍💼 Rachel Obi asks "What is the nightly limit for a hotel in London?". Your BM25 from step 1 would rank Kestrel's chunks well, but it lives in memory, rebuilds from scratch, and knows nothing of who may read what. The app's lexical search runs inside Postgres instead, on pg_search's BM25 index, in the same transaction as the tenant's RLS policy and the ACL pre-filter.

## Terms

- `chunks_bm25_idx` is the app's BM25 index over `chunks.text`, built by pg_search in the migration `m1_search_indexes`.
- A **tokenizer** cuts text into terms. This index uses `unicode_words` (split into words, lowercased), an English **stemmer** (cuts words back to a stem: "nightly" and "nights" to "night") and English **stopwords** (words too common to keep: "the", "is", "a").
- `|||` matches a field against **any** of a query's terms; `&&&` would need **all** of them. `pdb.score(id)` is the BM25 score of the row being read.
- The **pre-filter** is the list of documents the viewer may read (section 09). **RLS** (row-level security) hides other tenants' rows.

## Do this

🐨 In `playground/lexical.ts`, write `lexicalSearch`: one query that matches, filters, scores and orders. The tests load the 434 recorded chunks into a real `chunks` table with the app's index, and need Postgres.

## A worked example

The index reads Rachel's question as five terms: what, night, limit, hotel, london. "is", "the", "for", "a" and "in" are stopwords, and "nightly" is stemmed to "night" ("what" isn't on the list, so it stays).

The best chunk is section 11 of the expenses policy v2, "What changed from version 1.0", at 20.5513: a table that has "Hotel, London" and "a night" side by side. Next come the "4. Limits" tables of version 1 and version 2, which are word for word the same, so both score 19.2473; the tie goes to the smaller id. The hotels clause itself (section 4.2) is fourth, at 16.5093. (Each score is BM25 plus 1: pg_search adds 1 for the document filter it ran inside the index, the same for every row, so the order doesn't change.) Vector search put it first (section 06): the two lists disagree, which is why the app runs both.

Run the tests with `pnpm ex test 07.2`.
