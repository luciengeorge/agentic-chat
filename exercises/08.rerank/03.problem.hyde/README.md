---
title: HyDE
type: graded
slots:
  query/hyde: hyde.ts
---

# HyDE

👨‍💼 Questions and answers are worded differently. Sofia asks what the Ombudsman _decided_; the filing says the Ombudsman _upheld complaint CMP-2026-01171 (FOS reference DRN-2026-118230)_. HyDE is a well-known trick for that gap. Kestrel wants to know if it's worth a model call on every question. You'll build it, then measure it.

## Terms

- **HyDE** (hypothetical document embeddings) asks the model to write the passage that _would_ answer the question, then searches with that passage's embedding instead of the question's alone. The passage's facts may be made up; only its wording matters.
- An **embedding** is a list of numbers that places text by meaning. **Cosine similarity** says how close two embeddings point, from about 0 (unrelated) to 1 (the same).
- `retrieve` runs HyDE, when it's on, as one more vector list beside the question's and the rewrites'. It's off by default. `pnpm eval --hyde` turns it on.

## Do this

🐨 Write two functions in `playground/hyde.ts`:

1. `modelHypothesis`: ask the model for the passage, as structured output, and trim and cap it.
2. `hydeEmbedding`: write the passage for a question and embed it.

## A worked example

The recorded passage for Sofia's question: "The Financial Ombudsman Service issued its final decision on complaint CMP-2026-01171, upholding the complaint in part..." Cosine similarity, with the real embeddings:

| To                                     | The question | The passage |
| -------------------------------------- | ------------ | ----------- |
| Filing page 845, the decision          | 0.570        | 0.624       |
| The Compliance Monitoring Report, p. 3 | 0.551        | 0.564       |

The passage is nearer both. And it still costs Sofia the report: its 40 nearest chunks are all filing pages, and that one more list pushes the report from #27 to #33, past the 30 the reranker reads (step 1).

Run the tests with `pnpm ex test 08.3`. They replay the model's recorded passage and the recorded vectors.
