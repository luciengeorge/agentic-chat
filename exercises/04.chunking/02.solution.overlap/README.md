---
title: Overlap
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Overlap: the solution

`tail` walks a closed window backwards from its last unit, adding up each unit's tokens plus 1. It stops at the first unit that would take the total over `overlap`, and returns the units it passed, in their original order. `pack` starts the next window with them.

## Why it works

- **It mends the cut.** The sentences just before a cut are the context the sentence just after it needs. Carrying them over puts every sentence next to its neighbour in at least one chunk, so a fact split by a cut is whole in the next chunk.
- **It carries whole units only.** It stops at the first unit that doesn't fit rather than cut one to fill the budget. A carried fragment would be noise to the embedding, and half a contract number can't be found.
- **It can carry nothing.** If the last sentence alone is over the overlap, nothing repeats. That's the right call: repeating a 100-token sentence to save 64 tokens of context costs more than it mends.
- **`pack` won't close a window of repeats.** It counts the units it `added` after the overlap and only closes a window once there's at least one, so every chunk says something new.

## The worked example

Page 2 of the Ashgrove MSA at a target of 384. Without overlap, the second chunk starts "It must then pay an early termination fee", which leaves out who pays and why. With 64 tokens of overlap, `tail` collects clause 10.1's first sentence (37), the heading `## 10. Termination` (7, so 44) and "Nothing limits liability for fraud, death or personal injury." (12, so 56). The sentence before that would make 79, so it stops. The second chunk grows from 279 to 333 tokens, and clause 10.1 is whole in it.

The price: at the defaults, a long section repeats up to 64 of every 512 tokens, about an eighth more to store and embed.
