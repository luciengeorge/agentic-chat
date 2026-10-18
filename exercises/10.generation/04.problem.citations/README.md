---
title: The citation validator
type: graded
slots:
  cite/citations: citations.ts
---

# The citation validator

👨‍💼 Grace Adeyemi's answer says the Brindle invoice charges £1.62 a pack where the contract says £1.58, and that AP will pay only against a credit note. Each claim ends in a citation, and each citation becomes a chip that opens the scanned page. If a chip's quote isn't on that page, Grace is shown proof that isn't there. So before an answer is stored or shown, every citation is checked, and the ones that fail are dropped and the answer flagged.

## Terms

- A **citation marker** is `[[S1: "a quote"]]`: a **label** (which source) and a **quote** (words copied from it). `parseCitations` finds them.
- A quote **matches** when its words appear in the source's text after both are **normalised** (`normalizeForMatch`): lower case, no markdown stars or underscores, no table pipes, straight quotes, single spaces.
- An **elided** quote skips words with an **ellipsis**, `...` or `…`: each piece must appear, in order.
- A **drop reason** says why a citation went: `malformed`, `unknown-source`, `no-quote`, `quote-too-short` (under `MIN_QUOTE_CHARS`, 8, once normalised) or `quote-not-found`.

## Do this

🐨 In `playground/citations.ts`, write `quoteInText` (do this quote's pieces appear in this text, in order?) and `validateCitations` (keep or drop each marker, with the first reason that applies, and flag the report).

## A worked example

Grace's recorded answer has three citations, all of S1, the AP notes page of the scanned batch. OCR read that page as:

> Brindle has charged £1.62 a welcome pack; the PO and contract KPC-2025-0204 2 ; ‘say £1.58.

The model quoted "charged £1.62 a welcome pack; the PO and contract KPC-2025-0204 say £1.58". It tidied away the `2 ; ‘` the scanner put before "say", so the quote isn't in the text: **dropped, `quote-not-found`**. Its other two, "The difference is £80.00 plus VAT (2,000 packs at £0.04)" and "Pay only against a credit note or a corrected invoice.", are there word for word and kept, opening page 1. One drop flags the answer.

The 8-character rule is counted after normalising: `**£40**` is 7 characters raw and 3 without its stars. Too short either way.

Run the tests with `pnpm ex test 10.4`.
