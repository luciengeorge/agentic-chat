---
title: Token-based sizing
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Token-based sizing: the solution

`pack` walks the units once and keeps two things: the window it's filling and what that window costs so far. Before it adds a unit, it asks whether the unit fits. If the total plus the unit's cost would go over the target, and the window holds something, the window closes and an empty one starts. Then the unit goes in. After the loop, the last window closes too.

## Why it works

- **It measures what the models measure.** `countTokens` uses the same tokenizer as the embedding and chat models, so 512 here means 512 to them. Characters would lie: "Tom Whitfield" and "KPC-2026-0142" are both 13 characters, but 3 and 8 tokens.
- **It errs high.** Each unit costs its tokens plus 1 for the join. A blank line between blocks is a token, but a space usually merges into the next word's token and costs nothing. So the running total sits at or above the finished chunk's real count, which is what makes "never over the target" safe.
- **It only closes a window that holds something.** A sentence can be as big as the target by itself, which is more than any window has room for. It still has to go somewhere, so it gets a chunk of its own instead of leaving an empty one behind.
- **It fills each chunk as far as it can.** A window only closes when the next unit doesn't fit, so there are as few chunks as the order of the sentences allows.

## The worked example

Page 2 of the Ashgrove MSA: 27 units, 618 tokens. The running total reaches 509 after 20 units. The 21st, `## 12. Subcontracting`, costs 8: 517 is over 512, so the first chunk closes. `countTokens` gives it 494, 15 under the running total. The other 7 units make a second chunk of 131 tokens.

That first chunk holds clauses 5.2 to 11: security, data protection, audits, liability, termination and exit in one piece. Step 3 fixes that.
