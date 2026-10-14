---
title: Structure-aware chunking
type: graded
slots:
  chunk/chunk: chunk.ts
---

# Structure-aware chunking: the solution

`sections` walks the units and builds a list of sections. A heading starts a new one, unless the section being built holds only headings so far; then the heading joins it. Every other unit joins the current section, and the units before the first heading make a section of their own. `chunk` then packs each section on its own.

## Why it works

- **One topic per chunk.** A chunk is searched through a single embedding. A chunk that is half liability and half termination gets a point between the two, so a question about either matches it less well. Cutting at headings keeps each chunk on one subject, and the `section` label tells the model which.
- **Titles stay with their text.** `# Runbook` followed by `## 1. Pipeline` opens one section, so no chunk is a title on its own. For the same reason `pack` never closes a window on a heading.
- **Overlap stops at the heading for free.** Each section starts with an empty window, so nothing from the section before is carried in. Overlap is for a fact cut in half, and a heading is where the subject changes anyway. `tail` also stops at a heading, so a section's later chunks don't repeat it.
- **It costs chunks.** Short sections make short chunks: more rows to store and search, and less context in each.

## The worked example

Page 2 of the Ashgrove MSA at the defaults goes from 2 chunks (494 and 185 tokens) to 10: 86, 61, 42, 48, 66, 137, 54, 45, 61 and 25. The 66-token chunk is clause 9, "Liability", all of it and nothing else, labelled "9. Liability". The first chunk, the end of clause 5, has no section on this page alone, because its heading is on page 1; ingestion chunks the whole document, where it gets one.
