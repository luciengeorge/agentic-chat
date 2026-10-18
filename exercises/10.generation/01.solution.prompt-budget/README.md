---
title: Prompt assembly and the token budget
type: graded
slots:
  generate/prompt: prompt.ts
---

# Prompt assembly and the token budget: the solution

`fitSources` walks the chunks in rank order. For each one it renders the block with the next free label, `S${sources.length + 1}`, and counts it. If that would take the total over the budget, the chunk's id goes on the `omitted` list and the loop moves on; otherwise the block and its source are kept and the count added.

`fitHistory` walks a reversed copy of the history. Each turn's content (an assistant turn with `stripCitations` applied) is counted; the first turn that doesn't fit ends the loop, and every turn that fits is `unshift`ed, so the kept turns come out oldest first. Then a leading assistant turn is shifted off and its tokens taken back.

## Why it works

- **It counts what the model reads.** The model pays for the tag, the title, the path and the text. Counting the rendered block keeps the total honest: Grace's S1 is 460 tokens of text and 510 as the model sees it.
- **Labels have no gaps.** A label is the source's place among those that went in, so the model reads S1 to S20 in order, and the validator (step 4) maps each label back to exactly one chunk.
- **Skipping keeps the budget full of the best evidence.** The reranker already ordered the chunks. Going on past a misfit takes the next best one that still fits, so the 6,000 tokens hold as much of the top of the ranking as they can.
- **History stops at a misfit.** A conversation only makes sense in one piece. Turns are taken from the question backwards, and a gap would join two questions or orphan an answer, so the first one that doesn't fit ends it.
- **The user speaks first.** A kept history that starts on an answer drops that answer, and its tokens with it.

## The worked example

At the app's k, Grace's 8 sources are 3,667 tokens. Over all 30 reranked chunks: 18 in at 5,714; chunk 19 (290 tokens) would make 6,004 and is skipped; chunk 20 (100) goes in as S19 at 5,814; 21 and 22 don't fit; 23 goes in as S20 at 5,984; the last 7 don't fit. 20 in, 10 out.

The budget is also why the reranker's order matters this much: past 6,000 tokens, a chunk the reranker ranked low is simply never read.
