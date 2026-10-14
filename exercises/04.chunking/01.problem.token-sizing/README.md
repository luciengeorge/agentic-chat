---
title: Token-based sizing
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Token-based sizing

👨‍💼 Maya Levi, a paralegal at Kestrel, asks the assistant about the exit terms in the Ashgrove contract, KPC-2026-0142. To answer, search has to find the right piece of the contract, and the model has to read it. Both of those work on chunks, and both have limits measured in tokens. So the first job of a chunker is to keep every chunk inside a size, counted the way the models count.

## Terms

- A **token** is a piece of text the model reads as one item: a short word, part of a long word, a digit group, a symbol. A **tokenizer** cuts text into tokens. Ours is `o200k_base`, the one OpenAI's current models use, and `countTokens(text)` counts with it.
- A **unit** is the smallest piece a cut can fall between. For now that's a sentence (or a heading line).
- A **window** is the list of units that will become one chunk.
- The **target** (`targetTokens`, 512 by default) is the most tokens a chunk may hold.

## Do this

🐨 Open `playground/chunk.ts` and write `pack`: walk the units in order and fill a window until the next unit wouldn't fit, then start a new one. The hints in the file walk you through it. Everything else (splitting text into sentences, joining a window into a chunk) is already written. `overlapTokens` does nothing yet; that's step 2.

## A worked example

Page 2 of the Ashgrove MSA parses into 27 units, 618 tokens in all. With a target of 512, the running total after 20 units (clause 5.2 through clause 11, "Exit") is 509. The next unit is the heading `## 12. Subcontracting`, 7 tokens, so 8 with its join: 517, over 512. The window closes there. The finished chunk holds 2,034 characters, and `countTokens` says it is 494 tokens. The last 7 units make the second chunk, 131 tokens.

Run the tests with `pnpm ex test 04.1`.
