---
title: Local models, and the local reranker
type: graded
slots:
  local/rerank: rerank.ts
---

# Local models, and the local reranker

👨‍💼 Kestrel's compliance team has a question from its regulator: can the assistant run with no document leaving Kestrel's network? Chat and embeddings can move to LM Studio, on the same machine. The reranker is the hard part. Cohere's is a hosted API, so its stand-in has to run inside the app, from weights on disk, and score the way Cohere does: high for the chunk that answers, near zero for the rest.

## Terms

- A **cross-encoder** reads the question and one chunk together, as one input, and gives back one number for how well the chunk answers it. bge-reranker-base is one (278 million parameters, 279 MB as int8: its weights rounded to 8-bit whole numbers, a quarter of the size).
- A **logit** is that raw number: any size, either sign. On the example below they run from -10.2 to 3.7.
- A **sigmoid** squashes one logit into (0, 1): 1 / (1 + e^-x). A **softmax** turns a row of logits into shares that add up to 1.
- **ONNX** is a file format for a trained model, so any runtime can load it. Xenova converted bge-reranker-base to it.
- **transformers.js** runs Hugging Face models in Node, on onnxruntime (a native engine that runs ONNX files). Its **pipeline API** wraps a model in one call; we call the tokenizer and the model ourselves instead.

## What's already written

`MODEL_PROVIDER=local` (in `src/lib/retrieval.server.ts` and the chat's `-deps.ts`) puts every model on the machine and builds no OpenAI or Cohere client. Chat goes to LM Studio (`#learn/local/lmstudio`). Embeddings use nomic-embed-text, 768 dimensions padded with zeros to the column's 1,536, which changes no distance, under their own version so they're never compared with OpenAI's (`#learn/local/embed`). In `rerank.ts`, `loadCrossEncoder` loads the weights with `AutoTokenizer` and `AutoModelForSequenceClassification`, and `crossEncoderReranker` sorts the scores.

## Do this

🐨 In `playground/rerank.ts`, write `sigmoid`, then `crossEncoderScores`: pair the question with each chunk, run the model, and turn each logit into a score. The hints say how, and the three silent mistakes.

## A worked example

The golden question `expenses-london-hotel`: "What is the nightly limit for a hotel in London?" (£200 under version 2 of the travel policy, £180 under version 1). The recorded logits, and what the sigmoid makes of them:

| Chunk                               |   Logit | Sigmoid | Pipeline |
| ----------------------------------- | ------: | ------: | -------: |
| Version 2, "4. Limits" (the answer) |   3.146 |   0.959 |      1.0 |
| Version 1, "4. Limits"              |   3.694 |   0.976 |      1.0 |
| Version 2, "11. What changed"       |   1.689 |   0.844 |      1.0 |
| Brightwell contacts                 | -10.181 | 0.00004 |      1.0 |

The pipeline scores all four 1.0, so a reranker on it changes nothing. The sigmoid tells them apart, and still puts version 1 first: a small cross-encoder doesn't read "the one in force now". Over the golden set's 40 questions that have an answer, local retrieval (no query rewrites) still finds every labelled page in its top 10 (recall@10 1.000), but its MRR, the mean of 1 over the rank of the first right chunk, is **0.887**, against 0.944 hosted. This question is one of the six that lost rank 1: it counts 1/2 instead of 1.

The local answer eval is still pending: it needs a chat model in LM Studio, and none is downloaded. Qwen3 8B fits (about 5 GB): `lms get qwen/qwen3-8b`, then `pnpm local:eval`.

Run the tests with `pnpm ex test 21.1`. They replay the recorded logits, so they need neither the weights nor LM Studio.
