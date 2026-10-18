---
title: Batch embedding
type: graded
slots:
  embed/embed: embed.ts
---

# Batch embedding

👨‍💼 Ingestion has just cut the 3,000-page regulatory filing into 5,274 chunks. Before anyone can search them by meaning, each needs its embedding from OpenAI. One request per chunk is 5,274 round trips. One request for all of them breaks OpenAI's limits. And whatever the split, every vector has to land back on the chunk it was made from.

## Terms

- An **embedding** is a list of numbers that stands for what a text means: 1,536 of them for `text-embedding-3-small`. Texts about the same thing get vectors that point the same way. Each vector comes back at length 1.
- **Cosine similarity** measures how close two vectors point, from 1 (the same direction) to 0 (unrelated).
- A **batch** is a group of texts sent in one request. OpenAI takes at most 2,048 texts and 300,000 tokens per request, and bills per token: $0.02 per million for this model.
- `embedMany` is the AI SDK's call for a list of texts; `usage.tokens` is what the provider counted.

## Do this

🐨 In `playground/embed.ts`, write `batches` (cut a list into runs of a size) and the embedder's `embed` (one `embedMany` call per batch, every vector checked and kept in order, usage reported). The hints in the file walk you through both. The model is a parameter, so the tests hand it a fake that plays OpenAI with recorded vectors.

## A worked example

The 434 recorded chunks hold 68,459 tokens. At 256 a batch that's 2 calls: 256 chunks (44,347 tokens) and 178 (24,112). Cost: 68,459 / 1,000,000 × $0.02, about a seventh of a cent.

The filing's 5,274 chunks hold 2,104,091 tokens: 21 calls, twenty of 256 and one of 154, and $0.042. The heaviest batch is 112,920 tokens, so the 300,000 cap is never close.

What you get back: Rachel Obi's question "What is the nightly limit for a hotel in London?" is 1,536 numbers starting `0.0224, 0.0127, 0.0420, -0.0329`. Against the hotels clause of the expenses policy (section 4.2, page 2 of v2) its cosine similarity is 0.6885, the best of all 434 chunks. Against the first chunk of the sales playbook it's 0.0158.

Run the tests with `pnpm ex test 06.1`.
