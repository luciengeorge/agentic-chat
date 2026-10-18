---
title: Changing a tokenizer without downtime
type: graded
slots:
  search/reindex: reindex.ts
---

# Changing a tokenizer without downtime

👨‍💼 A search for "2026" finds the Ashgrove contract, because the index cut "KPC-2026-0142" into kpc, 2026 and 0142. Kestrel wants identifiers kept whole. That's a new tokenizer, so a new index, and the app searches on every question: there must be no minute without lexical search, and no minute where its answers change before someone has checked them.

## Terms

- A **field** is one way the index has read a column. `text` is the column's own field; others are **aliases**, the same column read with another tokenizer (`text::pdb.regex_pattern(..., 'alias=text_v2')`).
- `LEXICAL_V1` is today's field (`unicode_words`, English stemming and stopwords). `LEXICAL_V2` is the change: a regular expression that keeps runs like `KPC-2026-0142` as one term, with the same stemming and stopwords.
- A **transition index** holds both fields. `CREATE INDEX CONCURRENTLY` builds it while the old index keeps serving.
- A **dual read** runs the same queries on both fields and compares what comes back. The **cutover** is changing which field the app searches (`lexicalField` in retrieve's settings).

## Do this

🐨 In `playground/reindex.ts`, write `beginTokenizerChange` (the order of the moves that put a transition index in place) and `compareFields` (the dual read). The DDL, the concurrent build, the drop-and-rename and `finishTokenizerChange` are written. The tests need Postgres.

## A worked example

On the 375 Kestrel chunks, "2026" matches 148 chunks on `text` and 144 on `text_v2`: four chunks hold 2026 only inside an identifier. "KPC-2026-0142" matches 150 chunks on `text` (any of its three terms will do) and 8 on `text_v2`, each holding the whole number.

After `beginTokenizerChange`, every search on `text` gives exactly what it gave before, scores included, and one index is serving. The dual read over the eight golden questions about identifiers keeps 0.6, 0.7, 0.8, 0.8, 0.9, 0.9, 0.5 and 0.6 of their top 10. For Leo's KPC-2026-0142 question both fields still put the MSA's first page first; 4 of the other 9 change.

Run the tests with `pnpm ex test 07.4`.
