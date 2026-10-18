---
title: The pg_search index
type: graded
slots:
  search/lexical: lexical.ts
---

# The pg_search index: the solution

```sql
SELECT id, pdb.score(id) AS score
FROM chunks
WHERE text ||| $query AND document_id = ANY($documentIds)
ORDER BY pdb.score(id) DESC, id
LIMIT $limit
```

The field is `textField(options.field)`, plain `text` unless step 4 points it at an alias. Each row comes back as `{ id, score: Number(score) }`.

## Why it works

- **The query goes through the index's own tokenizer.** `|||` stems and drops stopwords in the query exactly as the index did in the text, so "nights" finds "night". Matching letters (ILIKE) can't do that, and can't rank.
- **Any term is enough.** Long questions are full of words no chunk has. OR keeps every chunk that shares something with the question, and BM25 sorts them; AND would keep only the rare chunk that has every word.
- **The query is a parameter.** It reaches pg_search as text and is tokenized, never parsed as SQL or as query syntax, so a quote, a bracket or the word AND is harmless.
- **Filtering happens in the index scan.** pg_search pushes `document_id = ANY(...)` and the tenant's RLS policy into its scan, so a chunk the viewer can't read is never returned. The ACL check and the search are one statement, in one transaction, in one database.
- **Ties have an order.** `ORDER BY score DESC, id` gives the same page every time, even when two chunks score the same.

## The worked example

Five terms (what, night, limit, hotel, london). Section 11 of the v2 policy first at 20.5513, then the two identical limits tables at 19.2473 in id order, then the hotels clause at 16.5093.

Two things to know. `pdb.score` here is BM25 plus 1. The document filter runs inside the index as a query of its own, and it adds a constant 1 to every row it lets through: without the filter, section 11 scores 19.5513. Ranks don't change, but scores from searches with and without a filter can't be compared.

And pg_search keeps its statistics (how many chunks hold each term, the average length) for the whole index, both tenants together. Harbour's chunks change the idf of Kestrel's words a little. The scores never reveal Harbour's text, but a careful attacker could learn from them whether a rare word exists somewhere in the index. When that matters, a tenant gets an index of its own (a partition or a table per tenant).
