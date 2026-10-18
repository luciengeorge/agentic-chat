---
title: The citation validator
type: graded
slots:
  cite/citations: citations.ts
---

# The citation validator: the solution

`quoteInText` normalises the text once, splits the quote on `ELLIPSIS`, normalises each piece, and searches for each with `indexOf(piece, from)`, moving `from` past each match. Any miss is false.

`validateCitations` maps sources by label and walks `parseCitations(text)`. No label is `malformed`; a label not in the map is `unknown-source`; no quote is `no-quote`; `normalizeForMatch(quote.replace(ELLIPSIS, " ")).length < MIN_QUOTE_CHARS` is `quote-too-short`; `!quoteInText(quote, source.text)` is `quote-not-found`. A citation that passes all of them takes the source's chunk and document ids, title, path and `pageStart` as its page. The report is flagged when anything was dropped or nothing was kept.

## Why it works

- **It compares words, not typesetting.** The model reads markdown and quotes prose. Normalising both sides the same way means a quote of a table row ("Hotel, London | £200 a night") or of bold text still matches, while a changed word or number doesn't.
- **Each citation is checked against its own source.** The chip opens S1's page, so the quote has to be on S1's page. A true quote pinned to the wrong source would send Grace to the wrong invoice.
- **Short quotes prove nothing.** A number or a word turns up in many chunks; 8 characters of normalised text is the least that reads as a phrase. Measuring after normalising stops markup padding a quote past the line.
- **Elisions keep their order.** Pieces found in order are one passage with words skipped; out of order, they could be two passages glued into a claim neither makes.
- **Dropping is quiet; flagging is loud.** The answer still shows, without the bad chip, and the flag marks it for review. In the eval (section 18), a flagged answer is one to read.

## The worked example

Grace's three citations of S1: "The difference is £80.00 plus VAT (2,000 packs at £0.04)" and "Pay only against a credit note or a corrected invoice." are kept, page 1; "charged £1.62 a welcome pack; the PO and contract KPC-2025-0204 say £1.58" is dropped, because the scan reads "KPC-2025-0204 2 ; ‘say £1.58". The answer is flagged.

That drop is the validator doing its job on noisy text, and it's also a cost: the claim is right. The fix isn't a looser match. It's better OCR text (section 03's review queue) so the quote and the source agree.
