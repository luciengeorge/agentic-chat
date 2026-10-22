# Agent notes

For any agent working in this repo: how the learner learns, the house rules for writing, and the traps in this environment. `PLAN.md` says what to build; `AGENTS.md` says how the code is laid out. The project's history lives outside the repo, in Lucien's notes.

## How the learner learns

Lucien is a full-stack TypeScript engineer (pnpm, Vite, React, TanStack Router, Query and Start, shadcn on Base UI, Tailwind, zod, Vitest, oxlint, oxfmt, tsgo). He had not built a production agent app before this course, and its goal is that he can.

- **He recognises a right answer at once, and struggles to produce one cold.** Steps must make him produce the mechanism, not pick it out.
- **He states the fact and stops before the mechanism.** "It adds latency" without "because the traversal visits more nodes." Hints and tests should push for the why.
- **When stuck, he asks for the answer** instead of reasoning out loud. Hints should give the next small push, never the whole move.
- **He wants plain language, and every term defined.** In his words: "assume i have little knowledge in building AI pipelines."
- **Worked examples with real numbers land.** Recall@k with 2 of 3 chunks, NDCG built up from its name, index size from `chunks × dims × bytes`, cross-encoders as "the librarian who opens each book".

So:
- Define every term the first time it appears in a README.
- 🦉 hints say why, at the level of the mechanism; tests check behaviour only the mechanism explains.
- Labs make effects visible: rankings side by side, denied chunks, a run resuming after the server is killed.

## House rules

- **Writing** for anything he reads: plain words, every term defined, varied sentence length, no em dashes, no "not X, but Y".
- **No shortcuts on the AI layers.** Production tools, each built small by hand first. The plumbing around them comes from a framework he knows.
- **Comments** only where the code needs clarification.
- **His `~/.claude/CLAUDE.md` binds:** be concise; the main model plans and judges, code goes to subagents, reviews go to a fresh agent, Codex is read-only; end every plan with concise unresolved questions; record work in the Obsidian vault.
- **The vault** (`~/obsidian/AGENTS.md`): every change gets a timestamped bullet in `daily/YYYY-MM-DD.md`, project hubs live at `projects/<slug>/index.md`, commit after writing. Other agents append to the same daily note at the same time, so append rather than rewrite, and `git add` only your own paths.
- **Never touch the learner's playground.** He works through steps while agents build. Agents never run `pnpm ex start`, `reset`, `solution`, `stop` or `drill` against the real repo, and never edit `playground/` or `.ex/`.
- **Machine etiquette.** Stop only processes you started, by PID; never `pkill` by a broad pattern (other projects run dev servers here). Never use his browser sessions.

## Environment traps

- **Postgres.** ParadeDB owns port 5432 through the repo's Compose. Brew `postgresql@14` and `@18` are stopped; don't start them, or they shadow 5432. `@14`'s data belongs to a legacy app; ignore it. The `psql` on PATH is the v18 client.
- **Docker** is OrbStack. When it isn't running, every database call fails with `ECONNREFUSED`: start it with `open -a OrbStack`, then `pnpm ex up`.
- **Disk.** Check free space before pulling images or downloading models. `docling-serve-cpu` is about 7 GB; a local chat model about 5 GB.
- **`cp` and `mv` are aliased to `-i`** in his shell, so scripts use `/bin/cp -f` and `/bin/mv -f`.
- **Port 3000 is shared with other projects.** `tanstack-starter-template`'s `pnpm dev` also listens on :3000 and looks almost like this app. `pnpm dev` passes `--strictPort`, and `pnpm ex smoke` checks `.ex/dev-server.json` names :3000. `lsof -nP -iTCP:3000 -sTCP:LISTEN` shows who holds it.
- **One dev server per `.workflow-data/`.** Each re-enqueues every open run it finds at boot. A second server needs its own `WORKFLOW_LOCAL_DATA_DIR`.
- **`.workflow-data/` is disposable.** With the dev server stopped, deleting it forgets every local run.
- **Bumping the ParadeDB image doesn't update the extension.** Run `ALTER EXTENSION pg_search UPDATE` in `ac` and in `template1` (test databases copy it), or queries fail with errors such as `function paradedb.ctid_is_valid(tid) does not exist`.
- **Vitest's module cache can't tell a slotted run from a reference run.** `learnSlots()` turns it off; keep it off.
- **The `@workflow/builders` patch** lets `learnSlots()` reach Workflow's step bundles. On every `workflow` upgrade `pnpm install` fails until it's re-made (`pnpm patch @workflow/builders@<version>`) or dropped. `docs/workflow-notes.md` (b) explains it.
- **The full test suite takes over 10 minutes** and is CPU-heavy (OCR, the ONNX reranker, workflow bundles). Run it in the background and alone; two at once time out.
- **Reasoning effort.** The GPT-5.6 series defaults to `reasoning: "none"`. Always set effort explicitly. `gpt-6-luna` is the default model.
