---
title: Lexical and hybrid search, done
---

# Lexical and hybrid search, done

You've written BM25 from its parts and matched pg_search's own scores, written the app's lexical search on pg_search's index with the ACL pre-filter inside it, explained a score term by term, changed a tokenizer while searches kept running, and merged two rankings by rank alone. Every question the assistant answers now goes through all of it: a BM25 list and a vector list per query, fused with your `rrf`, before the reranker.

## What to notice in the lab

Open `/labs/lexical` signed in as `leo.martin@kestrelpay.example` (password `dev-password`). It searches the dev corpus as Leo, so his ACL applies, and runs `#learn/search/*`.

- **"Who owns contract KPC-2026-0142, and when does its initial term end?"**: BM25 puts the Ashgrove MSA first; the vectors put contract register pages first and the MSA 10th; the fused list has two register chunks first and the MSA third. Hover a chunk to find it in the other lists. (The BM25 scores are higher than in the tests: the dev index also holds the filing, which changes every term's idf.)
- **"KPC-2026-0142"** on its own: the BM25 column is all chunks that hold the number; the vector column isn't.
- **"What is the nightly limit for a hotel in London?"**: the other way round. The vectors find the hotels clause first; BM25 puts tables that list every limit above it.
- **Your own question** is embedded by the app's embedder. Without an OpenAI key that's the hashing fake, whose vectors can't be compared with the corpus's, so the vector column stays empty and says so.

## What comes next

Section 08 reranks the fused list with a cross-encoder, which reads each chunk against the question, and that is the step meant to lift the MSA from third to first. It also tries rewriting the question and HyDE, and measures whether they help on this corpus.
