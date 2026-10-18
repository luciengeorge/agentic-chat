---
title: HyDE
type: graded
slots:
  query/hyde: hyde.ts
---

# HyDE: the solution

`modelHypothesis` calls `generateText` with the model, `HYDE_INSTRUCTIONS` as `system`, the question as `prompt`, `Output.object({ schema: PassageSchema, name: "hypothetical_passage" })` and the reasoning effort. It trims `output.passage`, cuts it at 2,000 characters, and throws if nothing is left. `hydeEmbedding` calls the writer with the question, embeds the passage alone, and returns both.

## Why it works

- **Answers look like answers.** A document and a model's guess at it share a register: statements, names, amounts, the identifier from the question. Their embeddings sit closer than a question's does, so the passage's nearest chunks are more likely to answer.
- **Wrong facts don't hurt the search much.** "Upheld in part, refund with interest, £150 for distress" is wrong (the Ombudsman upheld the complaint, and Kestrel refunded £3,850.00 to 412 customers), but the passage is about the right thing, in the right words. It's never shown to anyone.

## The worked example, and why it doesn't win here

The passage is nearer filing page 845's decision (0.624 against the question's 0.570) and nearer the report's page 3 (0.564 against 0.551). Then retrieval adds its 40 nearest chunks as a ninth list, and all 40 are filing pages. RRF gives every chunk in a list a share, so 40 more filing pages gain ground on the report, which is in BM25's lists only, and it drops from #27 to #33. The reranker reads 30. That's the one label the eval lost with `--hyde`: recall@10 0.988 against the default's 1.000, MRR the same 0.931, NDCG@10 0.928 against 0.938, for one more model call per question (about $0.005 a run of 46).

On this corpus HyDE has little to fix. The golden questions are written in the documents' words, the three rewrites (step 2) already add other wordings, and the reranker reads question and chunk together, so the gap HyDE closes is mostly closed. One huge document full of near-identical pages turns its extra list into noise.

HyDE wins when the gap is wide and nothing else bridges it: people asking in everyday words over documents in a specialist's (patients and clinical guidelines, customers and legal terms), no reranker, and embeddings that weren't trained on the domain. It also wins when there's no keyword search to catch the exact terms. Measure it on your own golden set before turning it on; that's what `pnpm eval --hyde` is for.
