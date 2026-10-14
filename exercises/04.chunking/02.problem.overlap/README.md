---
title: Overlap
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Overlap

👨‍💼 Kestrel's finance team asks "what does it cost us to leave the Ashgrove contract early?" The answer is in clause 10.1, and a cut has landed right in the middle of it. One chunk says Kestrel may terminate on 6 months' notice; the next starts "It must then pay an early termination fee equal to 50% of the platform fees". Neither chunk answers the question alone.

## Terms

- **Overlap** (`overlapTokens`, 64 by default) is how many tokens from the end of one chunk are repeated at the start of the next.
- The **tail** of a window is its last whole units, up to the overlap.

## Do this

🐨 Write `tail` in `playground/chunk.ts`: walk a closed window backwards and collect its last units, as many as fit in `overlap`. `pack` already calls it. When a window closes, the next one now starts with `tail(current, overlap)` instead of empty, and it counts the units it `added`, so a window that holds only repeated units never closes.

## A worked example

Page 2 of the Ashgrove MSA at a target of 384 and no overlap makes two chunks, and the second starts "It must then pay an early termination fee". With 64 tokens of overlap, `tail` walks back from the end of the first chunk:

| Unit (from the end)                                                         | Tokens + 1 | Running total     |
| --------------------------------------------------------------------------- | ---------- | ----------------- |
| "10.1 Kestrel may terminate for convenience on 6 months' written notice..." | 37         | 37                |
| "## 10. Termination"                                                        | 7          | 44                |
| "Nothing limits liability for fraud, death or personal injury."             | 12         | 56                |
| "Liability for breach of clause 7 or of confidentiality..."                 | 23         | 79, over 64: stop |

So the second chunk starts with those three units, and grows from 279 tokens to 333. Clause 10.1 is now whole in it.

Run the tests with `pnpm ex test 04.2`.
