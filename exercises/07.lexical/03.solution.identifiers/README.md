---
title: Identifiers
type: graded
slots:
  search/bm25: bm25.ts
---

# Identifiers: the solution

`explainScore` finds the document's position, then maps every distinct query term (`[...new Set(tokenize(query))]`, in query order) to its tf in the document, its df in the index, `idf(N, df)` and `termScore(tf, idf, length, averageLength, params)`. The score is the sum of the parts. An unknown id gives null.

## Why it works

- **It's the same arithmetic as bm25Search.** Same terms, same counts, same formula, so the parts add up to the score to the last decimal. A breakdown that didn't add up would be a story, not an explanation.
- **Absent terms are part of the answer.** A term with tf 0 says the word wasn't in the chunk, which is often the real reason a chunk ranked low.
- **Rare words decide, and identifiers are rare words.** In the MSA's score, "initial" (3 chunks) gives 6.06 and "and" (351 chunks) gives 0.27. An identifier's distinctive piece ("0142", in 9 chunks; "4031", in 5) is a rare word by construction, so BM25 weighs it heavily. Its common pieces ("2026", in 160) weigh little.

## Why vectors miss it

An embedding is trained to place texts by what they're about. "KPC-2026-0142" is about "a Kestrel contract from 2026", and so is every other contract number. So for the bare number the vectors find the contract register first, a page that lists other contracts (0.3955), and only 2 of their top 10 contain the number at all. With the full question they do better, because "owns", "initial term" and "end" carry meaning, but the MSA itself still comes 10th.

Neither list is enough alone: the vectors find the hotels clause for "nightly limit" (step 2's question) where BM25 ranks it 4th, and BM25 finds the contract where vectors rank it 10th. Step 5 merges them.

One caution for identifiers: the `unicode_words` tokenizer splits "KPC-2026-0142" into three terms, so "2026" alone matches every chunk from 2026. Step 4 changes the tokenizer to keep identifiers whole, without stopping search to do it.
