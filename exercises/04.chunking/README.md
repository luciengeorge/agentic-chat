---
title: Chunking
---

# Chunking

Kestrel's assistant never searches a whole document. Ingestion cuts each one into **chunks**, short pieces of text that each get stored, embedded and searched on their own. When the assistant answers, the chunks it found are what the model reads. So where the cuts fall decides what search can find and what the model gets to see.

A chunk that's too big covers many topics and matches none of them well. One that's too small loses the sentence that gave a fact its meaning. A cut in the wrong place splits a contract number, a clause or a table row in two.

## Terms

- A **token** is a piece of text a model reads as one item: a short word, part of a long word, a digit group, a symbol. Models count their limits in tokens.
- A **unit** is the smallest piece a cut may fall between: a sentence, a heading line, a table row.
- The **target** is the most tokens a chunk should hold (512 here). The **overlap** is how many tokens from the end of one chunk are repeated at the start of the next (64 here).
- A **section** is a heading and everything under it, up to the next heading.

## The steps

All four work in one file, `chunk.ts`, which the app imports as `#learn/chunk/chunk`. Each step's file is the last step's answer with one new function to write.

1. **Token-based sizing.** Pack sentences into chunks of at most the target, counted in tokens.
2. **Overlap.** Repeat the last sentences of each chunk at the start of the next.
3. **Structure-aware.** Start a new chunk at every heading, and label each chunk with its section.
4. **Table-aware.** Cut tables between rows, and repeat the header in every chunk that holds rows.

The lab, `/labs/chunking`, draws the chunks your code makes over a real page. Leave it open while you work.
