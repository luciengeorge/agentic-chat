---
title: Local models, and the local reranker
type: graded
slots:
  local/rerank: rerank.ts
---

# Local models, and the local reranker: the solution

`sigmoid` is one line: `1 / (1 + Math.exp(-x))`. `crossEncoderScores` walks the documents `batchSize` at a time. For each batch it calls the tokenizer with the query repeated once per document and the batch as `text_pair`, runs the model, checks the logits are shaped `[batch, 1]`, and pushes `sigmoid(Number(logit))` for each, in order. Sorting is left to `crossEncoderReranker`, which keeps the fused order on a tie.

## Why it works

- **The pair is one input.** `text_pair` makes the tokenizer build `<s> question </s></s> chunk </s>` for each document, so the model reads the two together and knows where one stops. That's the whole difference between a cross-encoder and an embedding: an embedding reads each text alone and compares two finished vectors; a cross-encoder compares word against word. It costs a forward pass per pair, which is why it only ever sees the 30 candidates fusion found.
- **One logit, one sigmoid.** A sigmoid maps each logit on its own, keeps their order, and puts 0.5 where the model is undecided. A softmax over a row of one logit is e^x / e^x, always 1. transformers.js's text-classification pipeline does exactly that for bge-reranker: its config has one label and no `problem_type`, so the pipeline assumes a single-label classifier and softmaxes. On the real weights it said 1.0 for every pair we tried, joined or paired.
- **The shape check is cheap insurance.** A two-label model would answer `[n, 2]`, and reading it as one column would mix documents up without a single error.
- **One pair per pass** is the fastest here (30 pairs in 2.3 s against 4.6 to 6.8 s batched, on an M4's CPU), and keeps each score independent of its neighbours, since the int8 model rounds its activations per batch.

## The worked example

"What is the nightly limit for a hotel in London?": logits 3.694 (version 1's limits), 3.146 (version 2's), 1.689 (version 2's "What changed") and -10.181 (Brightwell's contacts) become 0.976, 0.959, 0.844 and 0.00004. The reranker puts version 1 first, version 2 second. Cohere put version 2 first, so this question's reciprocal rank drops from 1 to 1/2, one of six that make local MRR 0.887 against 0.944. Recall holds at 1.000: the right page is always there, a place or two lower. The other losses are the two questions built on identifiers (KPC-2025-0142, KP-4031), which a small cross-encoder weighs less than Cohere does.

The time goes to the reranker. A local retrieval takes 3.2 s (median): 30 ms to embed the question in LM Studio, 94 ms in the database, 3.0 s for 30 pairs on the CPU. The model loads once per process, in 0.6 to 2.6 s.

## On the machine

- `pnpm local:weights` fetches the 296 MB of weights into `vendor/models`, each file checked (step 3 writes that check).
- `pnpm local:db` copies the dev database to `ac_local` and re-embeds it with nomic (5,708 chunks in 561 s, against OpenAI's 37 s), so `pnpm dev` keeps its OpenAI vectors.
- `pnpm local:eval --retrieval-only --no-rewrite` runs the golden set on local models; it needs LM Studio's server with nomic loaded.
- The answer eval waits for a chat model (Qwen3 8B, about 5 GB). Until then a local query can't be rewritten either, so the chat and the labs on local models need it too.
- `pnpm build:local`, then `MODEL_PROVIDER=local pnpm start`, runs the production build on local models. A plain `pnpm build` leaves transformers.js and onnxruntime-node out (about 330 MB of `.output`), since a hosted deploy never needs them, and says so if you try.
