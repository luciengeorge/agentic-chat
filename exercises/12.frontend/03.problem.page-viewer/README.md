---
title: Citation to the page viewer
type: graded
slots:
  frontend/citations: citations.ts
---

# Citation to the page viewer

👨‍💼 Leo's answer says the meal allowance is £40 a day. His manager will ask where that comes from, so every claim carries a small numbered chip. One click shows the passage the claim came from, and one more opens the policy itself, at the page. A chip that points at the wrong source, or always opens page 1, is worse than none: it teaches people not to check. The policy has 4 pages; the FCA regulatory return in `/Legal` has 3,000.

## Terms

- A **citation marker** is what the model writes after a claim: `[[S5: "Meals and subsistence | £40 a day"]]`. `S5` is the **label** of a source in the prompt, and the text in quotes is the **quote**, copied from that source.
- The **verdict** comes from section 10's citation validator, after the text: the citations it **kept** (the label names a source, and the quote is in it), each with its chunk, document and page, and the ones it **dropped**.
- A **chip** is the small numbered button a marker becomes. Chips are numbered by source, not by marker: two quotes from the same source share a number.
- A **URL fragment** is the part after `#`. The browser keeps it to itself: it's never sent to the server. A PDF viewer reads `#page=N` from it and opens at that page.

## Do this

🐨 In `playground/citations.ts`, write `resolveCitations`, which decides how each marker shows, and `documentHref`, the link that opens the original document. `collapseRuns` (two chips side by side with the same number become one) and the rest are written.

🚨 The classic mistake is a link without the `#page=` fragment. It opens the right PDF at page 1, so it looks fine until someone checks a claim on page 9. A `?page=2` query doesn't work either: that goes to the server, which ignores it.

## A worked example

Leo's answer has six markers: S5, S8, S4, S8 again, then S2 twice side by side. They become chips 1, 2, 3, 2 and a single 4: four sources, numbered in the order the answer first cites them, and the two S2 chips collapse into one. Chip 1 is S5, the limits table on page 2 of `Travel and Expenses Policy v2.pdf`. Click it: the panel shows "Page 2", the "4. Limits" section, and a link to `/api/chat/documents/d60a5e6b-…#page=2`. Chip 3 is the same row in the old policy, `Travel and Expenses Policy.pdf`, at £35.

## In the app

Ask "What's the daily meal allowance on a work trip?" as `leo.martin@kestrelpay.example`, or open that conversation again. While it streams, the chips are grey and can't be clicked. Once the verdict is in, hover chip 1 to see its quote, click it, then click "Open the document at page 2": the PDF opens on page 2, at the limits table. Chip 2 opens the same document at page 1, where the policy says which costs it covers.

Run the tests with `pnpm ex test 12.3`.
