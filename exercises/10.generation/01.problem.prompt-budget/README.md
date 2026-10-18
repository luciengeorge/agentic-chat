---
title: Prompt assembly and the token budget
type: graded
slots:
  generate/prompt: prompt.ts
---

# Prompt assembly and the token budget

👨‍💼 Grace Adeyemi in accounts payable asks: "Why is the Brindle Print & Post invoice in AP batch B-2026-117 on hold?" Retrieval finds the answer on a scanned page and hands over seven more chunks with it. The model only knows what its prompt holds, and the prompt has a size: every source costs tokens, so does every earlier turn of her conversation, and Kestrel pays for each one. Something has to decide what goes in.

## Terms

- A **prompt** is what the model reads for one answer: the **instructions** (the rules) and the **messages**. The last message holds the sources and the question; earlier turns of the conversation, the **history**, come before it.
- A **source** is one chunk rendered as a `<source id="S1" title="..." path="..." page="1">` block. Its **label**, S1, is what the model cites it by. Labels follow the order the sources go in.
- The **budget** caps what each part may cost: 6,000 tokens of sources and 1,500 of history (`DEFAULT_BUDGET`). The instructions are separate, 197 tokens.
- **Rank order** is the order retrieval returns chunks in, best first.

## Do this

🐨 In `playground/prompt.ts`, write `fitSources` (the sources that fit, in rank order, a chunk that doesn't fit skipped) and `fitHistory` (the newest turns that fit, starting on a user turn). `buildPrompt` puts them together; `renderSource` is written for now, and step 2 hardens it.

## A worked example

The app sends the model 8 chunks. Grace's 8 come to 3,667 tokens, well under 6,000: at the app's k a chunk is at most 512 tokens, so 8 can't fill the budget. It bites when more comes in. Hand `fitSources` all 30 chunks the reranker ranked for her:

- The first 18 go in, S1 to S18, and come to 5,714 tokens.
- Chunk 19, a 290-token section of the payment run procedure, would make 6,004: 4 over. It's skipped.
- Chunk 20 costs 100, makes 5,814, and goes in as **S19**: the 19th source the model reads.
- Chunks 21 and 22 don't fit; chunk 23 does, as S20, at 5,984. The last 7 are all too big for the 16 tokens left.

So 20 sources in, 10 left out, 5,984 tokens. Stop at the first misfit instead, and she gets 18.

Run the tests with `pnpm ex test 10.1`.
