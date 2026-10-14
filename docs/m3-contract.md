# M3 contract (exercises 00 to 12)

The shared agreements for M3's lanes. `PLAN.md` ("How the workshop works", "Curriculum") says why; `docs/m0-contract.md` holds the `ex` CLI, the slots and the gate rules; `docs/m1-contract.md` and `docs/m2-contract.md` describe the reference code the steps are carved from. If a lane has to break this contract, it says so in its report.

**M3 is done when** every step of sections 00 to 12 exists, `pnpm ex gate` passes for every graded step (fails on the problem, passes on the solution), every section has its lab panel, and a fresh reviewer has read every README.

Decisions Lucien made for M3:
- **A pilot first.** Wave 0 builds section 04 end to end, and Lucien does step 04.1 himself before the other sections start. His feedback updates this contract.
- **Medium hints.** 🐨 for each block of work and 🦉 everywhere. 💰 gives syntax and APIs only, never the algorithm: the learner has to produce the mechanism.
- **Lean labs.** One `/labs/<section>` panel each: a thin view over the app's own data that makes the section's effect visible.
- **No trimming.** The reference pieces that sections 01 to 09 still lack get built (wave 1) before those sections are carved.

| Wave | Lanes |
|---|---|
| 0 (pilot) | P. Section 04 end to end, plus the 00 tour fixes |
| 1 | Reference gaps. A: 06, 07, 08. B: 01, 02, 03, 05, 09 |
| 2 | 01 + 02; 03 + 05 |
| 3 | 06 + 07; 08 + 09 |
| 4 | 10 + 11; 12 |

## Who the learner is

Read `HANDOFF.md`, "How he learns", before writing a word. In short: Lucien recognises a right answer at once but struggles to produce one cold; he states the fact and stops before the mechanism; he wants plain words, with every term defined; worked examples with real numbers land. So:

- A README defines every term the first time it appears, in plain words. No unexplained acronyms.
- Each step has one worked example with real numbers, from this corpus where it can be (a real document, a real page, a real token count).
- 🦉 hints say *why*, at the level of the mechanism ("because the overlap repeats the last sentences, a fact split at a boundary is whole in one chunk"), never just *what*.
- Tests check behaviour that only the mechanism explains, so a learner can't pass by matching outputs.

## Step layout

```
exercises/04.chunking/
  README.md                       section intro: what Kestrel needs, the terms, the steps in a list
  01.problem.token-sizing/
    README.md                     the task (frontmatter: title, type, slots)
    chunk.ts                      the code to finish, with hints
    chunk.test.ts                 what "done" means (only in the problem dir)
  01.solution.token-sizing/
    README.md                     what the solution does and why, plus the worked example's numbers
    chunk.ts
  02.problem.overlap/ ...
  FINISHED.md                     recap, what to notice in the lab, what the next section builds on
```

- Files are `.md` with YAML frontmatter, like `exercises/_smoke` and `exercises/00.tour`. A step README's frontmatter has `title`, `type` (`graded`, `guided` or `lab`) and `slots` (`<area>/<module>: <file>`). Copy the shape from `exercises/_smoke/01.problem.greeting/README.md`.
- Steps within a section build on each other. Step N's problem file is step N-1's solution with the next piece stubbed, so a learner who finishes step N-1 can carry on in the same file.
- **Splitting the reference.** When a section's steps all live in one module, the reference may be split into one exported function per step (say `chunk.ts` into sizing, overlap, structure and tables), so each problem stubs one function. Behaviour and the app's own tests must not change. Keep the split small and natural, and note it in "Settled during the build".
- A problem file compiles and its stubs throw a clear "not written yet" error, as `_smoke` does. Everything a step doesn't teach stays filled in.

## Hints (in code, Epic React style)

| | Meaning | Rule |
|---|---|---|
| 👨‍💼 | Product context: why Kestrel needs this | One at the top of the file |
| 🐨 | Do this | One per block of work, in order |
| 💰 | A code tip | Syntax and APIs only (a method name, a regex flag), never the algorithm |
| 🦉 | Why it works this way | At least one per step, on the mechanism |
| 📜 | Docs to read | A real, stable URL |
| 🚨 | What the tests check | One per step, in plain words |
| 💯 | Extra credit | Optional, not tested |

## Tests

- Tests live only in the problem dir and import through the slot (`#learn/<area>/<module>`), never a relative path to the problem file.
- Every graded step's tests fail on its problem code and pass on its solution: `pnpm ex gate` checks both. Run `pnpm ex test <step>` against each target while writing.
- A test names the behaviour in plain words ("a heading starts a new chunk, even when the last chunk has room"). Test fixtures are small and built in the test, or come from the real corpus (`fixtures/corpus`) when the step is about real documents.
- No live model calls. Use the fakes the reference uses (`scriptedTurns`, the fake embedder, the overlap reranker).
- A test that runs a workflow is named `*.workflow.test.ts` (see `docs/m0-contract.md`).

## Labs

- **Routes:** a section's lab is `src/routes/labs/<section>.tsx`, linked from a small `/labs` index. It's a thin view over existing code and data (call the reference through a server function behind the viewer middleware), never a second implementation.
- **What a lab shows:** the section's effect, so the learner can see what changed when their code runs: chunks drawn over a page, rankings side by side, a run resuming.
- **Code:** a lab uses the slot imports (`#learn/...`), so it shows the learner's code while their step is active.
- **Style:** the repo's UI rules (shadcn, semantic tokens, `gap-*`, `size-*`). Lean: one panel, little chrome.
- **Step type:** a lab step (`type: lab`) is done when its observable result appears. Its README says exactly what to look for.

## Writing style

- **Who reads it:** Lucien. Plain words, varied sentence length, every term defined the first time, no em dashes, no "not X, but Y".
- **Product voice:** README tasks speak in it ("Kestrel's finance team searches for KPC-2026-0142 and gets nothing back. Here's why.").
- **Length:** a step README fits on one screen. Put depth in the 🦉 hints and the solution README.

## Wave 0 (pilot): section 04 and the tour

- **Section 04 Chunking**, 4 graded steps plus a lab:
  - token-based sizing;
  - overlap;
  - structure-aware (headings);
  - table-aware (rows and the repeated header).

  All four are in `src/core/chunk/chunk.ts` today; split it as above. The lab, `/labs/chunking`, picks a document and a page and draws the chunks over the parsed page, showing token counts and where the overlap repeats.
- **Section 00 fixes:**
  - 00.1 should say login lands on `/chat` and the tenant shows on `/me`;
  - 00.2's "most recent run" should point at an agent run (the "Run as agent" toggle) or a sync, since a plain chat question starts no workflow.
- The gate must pass for 04.1 to 04.4, and `pnpm ex start 04.1` must work from a clean checkout.

## Settled during the build

(Lanes add what they decided here: one bullet per decision, plain words.)

**Wave 1 lane A (reference for 06, 07, 08)**

- **06, vectors** (`src/core/vectors/`, tests in `vectors.test.ts`). `#learn/vectors/hnsw`: `hnswIndexSql`, `buildHnswIndex` (`m` and `ef_construction` as build options; it drops an index of the same name first and returns the build time), `setEfSearch`, `annNearest` (HNSW with sequential scans off), `nearest`, `PGVECTOR_DEFAULTS`. `#learn/vectors/recall`: `exactNearest` (index scans off, so a full scan), `recallAtK`. `#learn/vectors/truncate`: `truncateEmbedding` (keep a prefix, scale it back to length 1). `#learn/vectors/quantize`: `binaryQuantize`, `hammingDistance`, `binaryRescoreNearest` (over-fetch by Hamming distance from a `bit` HNSW index, then sort those by full cosine). `#learn/vectors/sizing`: `bytesPerVector`, `relationBytes`, `tableBytes`. `#learn/vectors/scratch`: `createScratchTable`, `loadScratchTable` (one row holds `embedding`, `half`, `bits` and `e256`-style prefixes). They work on any table, never the app's.
- **The bench.** `pnpm vectors:bench` copies the dev corpus's distinct embeddings (5,637 of 5,708 chunks: identical chunks tie and would fake misses) into a scratch database, `ac_vectors_bench`, dropped at the end. The queries are the golden questions, embedded once and cached in `fixtures/vectors/cache/` (gitignored). It writes `fixtures/vectors/reports/<date>.{md,json}`; the JSON is for the 06 lab's chart. HNSW recall moves a few points between runs, since the build is random.
- **What the bench shows** (2026-10-14). Exact scan 18 ms; HNSW at the defaults and ef_search 100: 87 to 91% recall@10 in 1.5 to 1.8 ms. At this size an HNSW index of `vector(1536)` is 44 MB whatever `m` is: a page holds 8 KB, and one 6,152-byte vector fills it. halfvec halves that (22 MB, same recall). Truncation costs recall: 256 dimensions keep 68% even with an exact scan. Bits alone find 68%; rescoring 200 candidates with full vectors gets 92% from a 2.7 MB index.
- **07, BM25 by hand** (`#learn/search/bm25`): `tokenize`, `idf` (Lucene's form), `termScore` (tf with `k1` and `b`, length normalisation), `buildBm25Index`, `bm25Search`, `DEFAULT_K1` 1.2, `DEFAULT_B` 0.75. The test works a three-document corpus by hand, and a DB test shows the same scores as pg_search's index with the `simple` tokenizer (to 5 places: pg_search keeps 32-bit floats).
- **07, changing a tokenizer** (`#learn/search/reindex`). Checked on pg_search 0.26.1: a table takes one ParadeDB index (a plain second `CREATE INDEX` fails: "a relation may only have one ParadeDB index"), but `CREATE INDEX CONCURRENTLY` may add one. Once it's valid, every query uses the newest index, and a query on `text` gets whatever that index has for the column, even an alias with another tokenizer. So two indexes can't be read side by side. What works: one transition index that keeps the old field exactly (same name, same tokenizer) and adds the new tokenizer under an alias (`text::pdb.regex_pattern(..., 'alias=text_v2')`). Built concurrently, it changes nothing for the app; then drop the old index, dual-read both fields, switch the field, and later rebuild with the new field alone. Functions: `fieldExpression`, `bm25IndexSql`, `buildBm25IndexConcurrently`, `bm25Indexes`, `replaceBm25Index` (drop concurrently, rename), `compareFields` (the dual read), `LEXICAL_V1`, and `LEXICAL_V2` as the example (identifiers kept whole). `lexicalSearch` takes a `field` option (`textField` builds it). The version setting is retrieve's `lexicalField`; no migration. The embedding half stays as it was (`embedding_model_version`); a zero-downtime model change would need a second column and HNSW index, noted in the module, not built.
- **08, HyDE** (`#learn/query/hyde`): `modelHypothesis(model, reasoning)` (structured output, `hypothetical_passage`, at most `MAX_PASSAGE_CHARS`), `hydeEmbedding`, the `HypotheticalWriter` type. Tests use the AI SDK's mock model, and a plain function in retrieve's tests.
- **08, routing** (`#learn/query/route`): `documentCards(tx, userId, documentIds, modelVersion)` (title, path and first chunk at the current version, only for documents the user can read through `readable`), `routeDocuments(question, embedding, cards, limit)` (the hand-built BM25 over the cards and cosine over the first chunk's vector, fused with RRF). Note: `readable`'s subqueries use the aliases `d` and `a`, so a caller's own `d` would be captured; `documentCards` uses `doc`.
- **Retrieve options** (`#learn/retrieve/retrieve`), all off by default, so the app's retrieval is unchanged: `deps.hyde` (a writer: its passage is embedded and searched as one more vector list), `settings.routeDocuments` (0 is off; otherwise chunks are searched only in that many routed documents) and `settings.lexicalField` (default `text`). The result gains `hypothetical` and `routedDocumentIds` only when they're on. `pnpm eval` takes `--hyde` and `--route N`, and its report's mode says which (`retrieval-only-hyde`, `retrieval-only-route5`).

**Wave 0 (pilot): section 04 and the tour**

- **The chunk split.** `#learn/chunk/chunk` now exports one function per step: `pack` (sizing), `tail` (overlap), `sections` (headings) and `tableRows` (tables), plus `cost` and the `Unit` and `TableHeader` types. `chunk` splits the units into sections and packs each one on its own. Its output is byte-identical to the old single loop over the whole corpus at five option sets (191,869 chunks), and the app's chunk tests are unchanged.
- **Each step's file grows.** Step N's problem file is step N-1's solution, plus the plumbing the new piece needs (already written, and listed in a 🦉 "new in this file" hint), plus one stub. Before step 3, headings are plain units and there are no sections; before step 4, a table goes through `pieces` as text, so the lab shows the problem each step fixes. Step 4's solution is the reference, byte for byte.
- **Worked examples are tested.** Each step's last test reproduces its README's numbers on a real page (page 2 of the Ashgrove MSA, page 5 of the contract register), parsing only that page with `parse(..., { pages })` and deps that refuse OCR. A change to the corpus or the tokenizer fails the test, not just the README.
- **Tests were checked against wrong answers.** Each step's tests ran against three or four plausible wrong implementations (counting characters, closing an empty window, carrying one sentence too many, no header repeat, a header counted twice...) and fail on each.
- **Stubs use their parameters** in their error message, since `noUnusedParameters` covers `exercises/`. For the same reason `cost` is exported: step 1's stub doesn't call it yet.
- **The lab.** `/labs` lists the labs; `/labs/chunking` picks a document, a page, a target and an overlap. Server functions in `src/routes/labs/-functions.ts`, behind `viewerMiddleware`: `getLabDocuments` (documents the viewer can read, with a page count from their chunks) and `getChunkedPage` (parses one page with the app's rasteriser and OCR, cached by content hash, then runs `#learn/chunk/chunk`; a throw from the chunker comes back as `error`). It chunks the page on its own (markdown and DOCX whole), so a page's first section may have no label. The overlap and the repeated header are found from the chunk texts alone (`src/components/labs/overlap.ts`), so they show whatever chunker made them. The sidebar links to `/labs`.
- **shadcn `select`** was added for the lab. The registry's file imported `cn` from an npm package called `cn` and added it to `package.json`; it now imports `@/lib/utils`, and the dependency is gone.
- **Eval** (`pnpm eval --retrieval-only`, 2026-10-14). Default, before and after this lane: recall@10 1.000, MRR 0.931, NDCG@10 0.938, gates pass. `--hyde`: 0.988, 0.931, 0.928 (`filing-fos-decision` loses a label; about $0.005 more a run). `--route 5`: 0.950, 0.921, 0.906 (`filing-merchant-exit` routes to the wrong documents and finds nothing; `filing-fos-decision` and `nda-restricted-exec` lose a label). On this corpus neither beats the default; that's the lesson the 08 lab can show. The reports are `fixtures/golden/reports/2026-10-14-retrieval-only{,-hyde,-route5}.{md,json}`.
- **`readable()` alias capture (main).** Its subqueries used the aliases `d`, `a`, `u`, `p` and `gc`, so a caller passing `d.id` had it captured by the inner `documents d`, and the "ready" check passed for any document. M1's chat history filter (`src/routes/api/chat/-store.ts`) passed `d.id`. The aliases are now prefixed `acl_`, with a test that names its own table `d`.
