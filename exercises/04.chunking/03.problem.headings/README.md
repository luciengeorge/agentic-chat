---
title: Structure-aware chunking
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Structure-aware chunking

👨‍💼 Kestrel's legal team asks "what's our liability cap with Ashgrove?" The answer is clause 9 of the MSA, three sentences long. Right now it sits in a 494-token chunk that also covers security, data protection, audits, termination and exit. Search has to match the question against all of that at once, and the cap is 66 tokens of it.

## Terms

- A **heading** is a title line in the document (`## 9. Liability`). The parser marks them as heading blocks.
- A **section** is a heading and everything under it, up to the next heading.
- An **embedding** is a list of numbers that stands for what a piece of text is about. Search compares the question's embedding with each chunk's, so each chunk gets exactly one.

## Do this

🐨 Write `sections` in `playground/chunk.ts`: split the units into sections, so `chunk` can pack each one on its own. The file has new pieces already written for you, listed in the 🦉 hints: heading units, the `section` label, and two small changes in `pack` and `tail`.

## A worked example

Page 2 of the Ashgrove MSA at the defaults (512 and 64), before and after:

|                                  | Chunks | Sizes in tokens                                                         |
| -------------------------------- | ------ | ----------------------------------------------------------------------- |
| Step 2: cut by size only         | 2      | 494 (clauses 5.2 to 11), 185 (131 plus 54 of overlap, clauses 11 to 14) |
| This step: one section per chunk | 10     | 86, 61, 42, 48, 66, 137, 54, 45, 61, 25                                 |

The 66-token chunk is `## 9. Liability` and its three sentences, labelled with the section "9. Liability". The first chunk, 86 tokens, is the end of clause 5, whose heading is on page 1; on this page alone it has no section. Smaller chunks mean more of them to store and search, which is the price of each one being about one thing.

Run the tests with `pnpm ex test 04.3`.
