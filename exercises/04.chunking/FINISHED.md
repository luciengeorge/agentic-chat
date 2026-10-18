---
title: Chunking, done
---

# Chunking, done

Your `chunk.ts` is now the one ingestion runs. It counts in tokens, so every chunk fits the target the way the models measure it. It repeats the last sentences of each chunk at the start of the next, so a fact cut in two is whole somewhere. It cuts at headings, so each chunk is about one section and says which. And it cuts tables between rows, with the header on every piece.

## What to notice in the lab

Open `/labs/chunking`, signed in as `leo.martin@kestrelpay.example` (password `dev-password`) or anyone in finance or legal, who can read the contracts.

- **Page 2 of the Ashgrove MSA**: ten chunks, one per clause, from 25 to 137 tokens. Set the target to 96 and the overlap to 32: clause 10 now splits in three, and each piece starts with the sentence before it shaded, "It must then pay an early termination fee..." included.
- **Page 5 of the contract register**: two chunks of 492 and 417 tokens, both starting with the 40-token header. The KPC-2026-0298 row is shaded at the top of the second: that's the overlap.
- **Any page with the overlap at 0**: nothing is shaded, and the chunks add up to the page exactly.

## What comes next

Section 05 runs ingestion as a workflow: parse, then your `chunk`, then store, one saved step at a time. Section 06 embeds each chunk, which is where the choices you made here start to cost money: every repeated overlap token is embedded twice, and every extra chunk is one more row in the index.
