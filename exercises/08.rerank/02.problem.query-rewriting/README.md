---
title: Query rewriting and expansion
type: graded
slots:
  query/rewrite: rewrite.ts
---

# Query rewriting and expansion

👨‍💼 Sam Patel, a platform engineer, asks: "When can't we ship code over Christmas?" The deploy runbook has the answer, a row in its "When you can deploy" table: "Winter freeze, 18 December 2026 to 4 January 2027". It never says "ship" or "Christmas". So the keyword search can't find the row, and the search that can puts it only 13th.

## Terms

- **Query rewriting** asks the model for other ways to say the question: in a document's words, with terms spelled out. **Expansion** is searching them all: each **rewrite** gets its own BM25 list and vector list, and fusion (section 07) adds up every list a chunk is in.
- A **list** is one search's ranked result: 40 chunks, best first.
- `StructuredModel.object` (section 01.4) asks the model for JSON that must fit a zod schema, and checks it.

## Do this

🐨 Write two functions in `playground/rewrite.ts`:

1. `modelRewriter`: ask the model for up to three queries, with the instructions and schema that are written for you.
2. `cleanRewrites`: trim them, and drop blanks, the question itself, and repeats, keeping at most three.

`retrieve` already searches the question plus whatever your rewriter returns.

## A worked example

The question alone makes two lists. BM25 finds the freeze table nowhere in its 40. The vector search puts it first, but fusion ranks by agreement, and one first place out of two lists comes 13th.

The recorded rewrites are "Christmas holiday code freeze shipping restrictions", "deployment and release freeze dates over Christmas and New Year" and "holiday change management policy production releases during Christmas period". The word that matters is "freeze". With them, the table is in 7 of 8 lists (BM25 at 5, 6 and 13, vectors at 6, 1 and 4), and it fuses to #4.

Run the tests with `pnpm ex test 08.2`. They replay the model's recorded reply and the recorded searches.
