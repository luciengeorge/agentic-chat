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
