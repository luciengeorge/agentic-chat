---
title: Citation to the page viewer
type: graded
slots:
  frontend/citations: citations.ts
---

# Citation to the page viewer: the solution

`resolveCitations` makes two lookups first: the verdict's kept citations by marker, and the sources by label. Then it walks the markers in the text. A repeated marker is skipped. For the rest, the verdict decides if there is one (kept: `valid`; not kept: `hidden`); before it, the sources do (label known: `pending`; unknown: `hidden`). Only a shown marker takes a number, from a map of labels: a new label gets `numbers.size + 1`, a known one keeps its number. `cited` is the valid entries, the first one per chunk, sorted by number. `documentHref` is `/api/chat/documents/<id>`, plus `#page=<page>` when there is a page.

## Why it works

- **One number per source.** The map is keyed by label, so S8's two quotes are both 2. To a reader that's one document saying two things, which is the truth.
- **Numbers in reading order.** The map hands out numbers as labels first appear, so the reader meets 1, then 2, then 3. The label's own number is search's ranking in the prompt, which the reader never sees.
- **The validator has the last word.** A marker is only the model saying "this came from S1". Once the verdict is in, a dropped marker (its quote isn't in the chunk, or its label names no source) shows nothing, and takes no number, so the numbers that are left still run 1, 2, 3.
- **Pending first, so nothing jumps.** While the reply streams, the validator hasn't run. A marker whose label names a source shows as a grey chip that can't be clicked yet. The chips are already in place when the verdict turns them into links, and the one or two the validator drops disappear.
- **The fragment stays in the browser.** `#page=2` is never sent to the server. The server sends the whole PDF, and the browser's PDF viewer reads the fragment and opens at page 2. A query, `?page=2`, would go to the server, which ignores it, and the viewer would open at page 1. A document without pages (markdown, Word) gets no fragment at all, rather than `#page=null`.

## The worked example

Leo's answer has six markers: `S5` (£40 a day, policy v2), `S8` (the policy's start date), `S4` (£35 a day, the old policy), `S8` again (costs before that date), then `S2` twice, back to back. The map gives S5 1, S8 2, S4 3, S8 2 again and S2 4. `collapseRuns` folds the two side-by-side 4s into one chip, so the page shows 1 2, then 3 2, then 4. Under the answer, "Sources" lists four documents' chunks, by number.

Chip 1 is S5: chunk `9fcb2ec3`, the "4. Limits" table on page 2 of `Travel and Expenses Policy v2.pdf`. Clicking it calls `getCitedChunk` for that chunk; the panel shows "Page 2", the section, the table with "£40 a day" in it, and the link `/api/chat/documents/d60a5e6b-…#page=2`. Its quote, "Meals and subsistence | £40 a day", spans two table cells, so the panel can't mark it (the chip's tooltip still shows it). Chip 4's quote, "travel overnight on business", sits inside one sentence, and the panel marks it.
