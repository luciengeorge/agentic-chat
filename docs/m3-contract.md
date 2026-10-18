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

## What the pilot taught (applies to every later section)

From building section 04 and from Lucien doing 04.1:

- **Listed plumbing is fine.** Step N's problem file may hold plumbing the new piece needs, written already, as long as a 🦉 "new in this file" hint lists it. "Previous solution plus one stub" alone was too tight.
- **The worked example is a test.** Each step's last test reproduces the README's worked example on the real page or document, with the README's numbers.
- **Wrong answers.** Before a step ships, run its tests against 3 or 4 plausible wrong answers (the mistakes a learner would make) and check each one fails with a message that points at the mistake. Name them in the lane's report.
- **The classic mistake gets its own hint.** Lucien's first 04.1 attempt closed a full window and dropped the unit that didn't fit, counted `unit.tokens` instead of `cost(unit)`, and pushed an empty window. The hints said all three, but in passing. So when a step has a well-known way to go wrong, a 🐨 or 🚨 hint names it outright ("on both paths, then add the unit"), and a test's failure message says what was likely missed.
- **Stubs use their parameters** (in the "not written yet" message), because `noUnusedParameters` covers `exercises/`.
- **Pick the story's user by access.** Choose a user who can read the documents the step uses: Nadia Kowalski can't read `/Legal`.
- **A solution README** explains the answer and why it works, with the worked example's numbers. It's not a copy of the problem README.
- **Never touch the learner's playground.** Lucien may have a step active while lanes work. Lanes never run `pnpm ex start`, `reset` or `solution`, and never edit `playground/` or `.ex/`. They check steps with `pnpm ex test <step> --target problem` and `--target solution`, and with `pnpm ex gate`. They start the dev server only if `:3000` is free, and stop it after.

## Wave 2 ownership

| Lane | Owns |
|---|---|
| A. Sections 01 + 02, plus the `ex` fixes | `exercises/01.*/**`, `exercises/02.*/**`, `src/routes/labs/{models,connectors}*`, `src/components/labs/{models,connectors}*`, `scripts/ex/**` (the fixes below), the reference splits those sections need in `src/core/{model,connectors}/**` |
| B. Sections 03 + 05 | `exercises/03.*/**`, `exercises/05.*/**`, `src/routes/labs/{parsing,background}*`, `src/components/labs/{parsing,background}*`, the reference splits those sections need in `src/core/{parse,queue}/**`, `src/workflows/**` (splits only) |

Shared files (`src/routes/labs/index.tsx` and `-functions.ts`, the contract's Settled section, `package.json`): re-read right before writing, change only your lines. No nested subagents. Never stop Docker or OrbStack.

**The `ex` fixes (lane A):**
- `ex start` prints what to do next: the step README's path, `pnpm ex test <id>`, and the lab URL when the section has one.
- `ex test` prints the warning "Postgres is unreachable" only when the step has database tests, and then names `pnpm ex up` as the fix.
- `ex test`'s failure output is short and readable: each failing test's name and its assertion message, without colour codes or the JSON report path.
- `pnpm ex stop` leaves no active step (after checking for unsaved playground changes, like `start`).

**Section notes:**
- **01:** steps for the provider interface, the hand-written Responses client with streaming, the tool-call wire format, and the AI SDK behind the interface with structured output and token counting. Lab: a request inspector that shows the request body and the SSE events of one call (it may replay a recorded cassette, so no live call is needed).
- **02:** steps for the connector interface, full crawl with pagination, 429 and `Retry-After`, delta and webhooks, deletes and moves. Lab: a fake-workspace control panel over `/_control/*` (faults, clock, deliveries).
- **03:** steps for text layer vs OCR, OCR confidences and the review queue, tables to markdown, page mapping. Docling compared is `guided`. Lab: a parsed-page viewer showing blocks, method and confidence, plus the review queue.
- **05:** steps for the job queue by hand, ingestion as Workflow steps with `RetryableError`, `FatalError` and limits, the outbox and relay (plus workflow-first), fan-out over the filing, and per-class limits against starvation. Lab: a queue board (jobs by class and state) plus a link to Workflow's run viewer.

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

**Wave 1 lane B (reference for 01, 02, 03, 05, 09)**

One migration, `20261014162949_m3_lane_b`: tables `acl_audit`, `directory_versions` and `ocr_reviews` (RLS forced, like every tenant table), and `jobs.class`.

- **01, structured output** (`#learn/model/types`, `#learn/model/responses`, `#learn/model/ai-sdk`, `#learn/model/testing`). A new interface, `StructuredModel`, with `object(request, schema)`: `ObjectRequest` is instructions, messages, a schema `name` and the effort; it returns `{ object, usage }`, checked with zod. `responsesChatModel` and `aiSdkChatModel` now return `ChatModel & StructuredModel`. `ChatModel` itself is unchanged: about ten test fakes implement it inline, and a required method would have meant editing every one. By hand: `strictJsonSchema(schema)` (zod's JSON Schema without `$schema`), `buildObjectRequestBody` (`stream: false`, `text.format` = `json_schema`, `strict: true`) and `createObject` (reads the message's `output_text`; a refusal, an `incomplete` reply or text that isn't JSON throws `ResponsesApiError`, a mismatch throws zod's error). Through the SDK: `generateText` with `Output.object`. Strict mode wants every field required, so an optional one is `.nullable()`. The fake is `scriptedObjects(replies)`.
- **01, query rewriting on it.** `modelRewriter(model: StructuredModel, effort)` in `#learn/query/rewrite` calls `object(...)` with the same instructions, the question as the one user message and the schema name `search_queries`. `rewriterFromEnv` and `pnpm eval` wrap their AI SDK model in `aiSdkChatModel`. `ReasoningEffort` there is now the model's own type. HyDE stays on `generateText` (lane A's).
- **01, token counting** (`#learn/model/tokens`): `countTokens` (o200k_base, special tokens as text), `countMessageTokens` (content, each tool call's name and arguments, 4 tokens of overhead: the formula the agent already used), `countToolTokens` (each tool's JSON), `countRequestTokens` (instructions, messages and tools, part by part) and `readUsage` (a finish event's usage as numbers, with `reported` false when none came back). `#learn/chunk/tokens`, `generate/prompt.ts` and `agent/context.ts` re-export it, so their counts are unchanged. `agent/caps.ts` keeps its own rough request count (one JSON string): moving it would change the caps' numbers.
- **02, the connector interface** (`#learn/connectors/types`): `Connector` (`crawl()` yields pages of `SourceFile`s, `latestCursor`, `delta(cursor)` gives `Change`s and the next cursor, `permissions(fileId)` gives directory ids, `content`, `subscribe`, `renew`), `SourceFile`, `Change`, `Subscription`, and the errors: `ConnectorError` (`status`, `code`, `retryAfterMs`, `retryable`) and `ResyncRequiredError`. In `#learn/connectors/graph`: `GraphRequestError` now extends `ConnectorError`; the client gains `crawlPages`; `graphConnector(client)` is the adapter, with `toSourceFile` and `grantedIds` (moved from `acl/stamp`, which re-exports it). Graph's delta quirks (a changed item has no path; a renamed folder lists none of its files) are handled in the adapter now, so `fullSync` and `deltaSync` take a `Connector` and never see a Graph type. `DriveSyncReport.deltaLink` is now `cursor`. `connectorFor(tenantId)` in `sync-common.ts` is what the drive step, the subscription step and the download use; `stepError` maps any `ConnectorError`.
- **03, the OCR review queue** (`#learn/parse/review`): `DEFAULT_OCR_REVIEW_THRESHOLD` (70), `pagesToReview`, `pageText`, `queueOcrReviews` (in the ingest step's chunk transaction, idempotent per document, version and page), `listOcrReviews` (readable documents only, current version, lowest confidence first), `acceptOcrReview`, `correctOcrReview` (deps: `withTenant`, an `Embedder`, `ParseDeps`), `spanToRecut`, `ReviewConflictError`. A queued page stays searchable: queueing only adds a row. A correction re-chunks the page plus any neighbour page one of its chunks runs into (on the MSA, pages 2 and 3), using the corrected text, other reviewed pages' stored text, and the text layer (or OCR) for the rest; it embeds the new chunks, then swaps them in one transaction, after checking that nothing moved. A chunk crossing into that span from outside stays, keeping a few repeated sentences as overlap does. Ordinals stay unique and in page order. `OCR_REVIEW_THRESHOLD` overrides the threshold (0 turns it off).
- **03, the threshold.** Measured on the corpus: the handwriting reads at 83 to 90, the scans at 51 to 67, the MSA's signature page at 45. At 70 the queue takes six pages (the AP batch's three, the Marlow and Finch order form's two, the MSA's page 3) and no handwriting. Since a queued page stays searchable, the golden OCR questions are unaffected whatever the threshold. The dev database holds no review rows until those documents are ingested again.
- **03, server functions** (`src/lib/ocr-review.functions.ts`, behind `viewerMiddleware`): `getOcrReviews({ status })`, `acceptOcrPage({ reviewId })`, `correctOcrPage({ reviewId, text })` (at most 20,000 characters; it uses the app's rasteriser, OCR and embedder).
- **05, workflow-first ingestion.** `INGEST_START=outbox|workflow-first` (default `outbox`), read by `ingestStart()` in `sync-common.ts`. In workflow-first mode the drive step writes no ingest rows and returns the versions as `startRuns`; `syncWorkflow` then runs `startIngestRuns` (`src/workflows/ingest-start.ts`, which also holds the note on when to use which), which starts `ingestWorkflow(..., null, { workflowFirst: true })`. Its first step, `recordIngestStart`, writes its own record through `recordStart` in `src/db/outbox.ts`: an outbox row with a uuid v5 id from `ingest:<document>:<version>` (`recordIdFor`), already published and claimed by the run, so a second start of the same version stops as `duplicate`. The starts are a step after the drive step, never inside it: the list is then a recorded step output, so a crash mid-start retries with the same list. Outbox runs replay unchanged, since the new step runs only when the list is there.
- **05, backfill vs incremental** (`#learn/queue/queue`, `#learn/queue/worker`). Every job has a `class` (`default` unless `enqueue(..., { class })` says). `claim` takes optional `ClassLimits`; `claimWithinLimits(db, queue, worker, leaseMs, limits)` counts and claims under a transaction-scoped advisory lock on the queue, so concurrent workers can't both take the last slot; `runWorker`/`workOnce` take `classLimits`. Why the queue: it's the only place in this app where a job holds a fixed slot for its whole life and slots are handed out oldest first. The relay only calls `start()`, which returns at once, so a backfill there costs a delta a few milliseconds of ordering. The fan-out already caps its own children at ten. Workflow's local world runs up to 1,000 steps at once, and Vercel's scales out. On the queue (two workers in dev), twelve page ranges of the filing queued first take both workers, and a webhook's delta waits for them all. Capping `backfill` at one less than the workers keeps a slot free. The tests show both: without caps the delta waits; with `{ backfill: 1 }` it takes the free worker ahead of eleven older ranges.
- **09, the principal cache** (`#learn/acl/principal-cache`): `createPrincipalCache`, `sharedPrincipalCache`, `directoryVersion`, `bumpDirectoryVersion`, `cachedPrincipals`. Keyed by tenant (read from `app.tenant_id`) and user; each entry holds the directory version it was read at. `applyDirectory` bumps the tenant's `directory_versions` row when a membership or a closure row changed (not when only `enabled` did: the set ignores it, and `readable()` checks it live). `viewerPrincipals(tx, userId, cache = sharedPrincipalCache)` in `#learn/retrieve/acl` reads through it; `null` skips it. `readable()` is unchanged and still decides every chunk against the live closure, so a stale set (a membership written by hand, a process that missed a bump) can only widen or narrow the pre-filter. A test removes a membership by hand without a sync and checks the stale set over-fetches the document while `canRead` refuses it.
- **09, the ACL audit log** (`#learn/acl/audit`): `setSyncRun(tx, runId)` (`SET LOCAL app.sync_run_id`, as the tenant is set), `recordDocumentAcl` (called by `stampAcl` on every change: `stamp`, or `clear` when nobody is left, with the principal ids before and after and the new `acl_version`), `recordMemberships` (called by `applyDirectory` for each direct membership added or removed), `aclHistory(tx, documentId)` (oldest first). The directory and drive steps set the run id, so every row a sync writes names its run. The app role has SELECT and INSERT on `acl_audit`, no UPDATE, DELETE or TRUNCATE; the owner still can.
- **Eval** (`pnpm eval --retrieval-only`, 2026-10-14, after this lane): recall@10 1.000, MRR 0.931, NDCG@10 0.938, gates pass, as before. The rewriter's input was 8,728 tokens both before and after the move to `object(...)`, so the request it sends is the same. It rewrote `fixtures/golden/reports/2026-10-14-retrieval-only.{md,json}`.

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
