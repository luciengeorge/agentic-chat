---
title: The course
---

# Build Kestrel's assistant

Kestrel Pay is a fictional payments company with about thirty people, a shared drive full of contracts, policies and board papers, and one rule: nobody sees a document they couldn't open in the drive. Its assistant answers staff questions from those documents, with every claim linked to its source, and runs small jobs for them (find a contract, email a colleague, share a report) with their approval. It's a small version of Cohere's North, the kind of system you'd be asked to design in an interview.

The whole assistant already runs. That's the **reference app**: the code in `src/`, which you start once and keep running. The course takes it apart one layer at a time. In each **step** you rewrite one piece of it (a chunker, a search, a citation chip) from a problem file with hints, the tests tell you when it's right, and the app runs on your code while you work, so you can watch it change. By the end you'll have built every AI layer of a production assistant by hand: parsing, chunking, embeddings, keyword and vector search, reranking, access control, generation, and the agent.

Two tenants share the app: **Kestrel Pay** and **Harbour Health**, a second customer whose documents must never reach Kestrel, or the reverse. A **tenant** is one customer organisation. The people, groups and folders all come from `fixtures/world.yaml`, and the documents from `fixtures/corpus/`.

## Start the stack

You need Docker (OrbStack is fine), Node 22 or later and pnpm 10. Copy `.env.example` to `.env.local` once, then:

```sh
pnpm install
pnpm ex up            # the database (ParadeDB, in Docker), its tables, and the people
pnpm dev              # the app, on http://localhost:3000 (its own terminal)
pnpm fake-workspace   # the stand-in for the company drive, on http://localhost:8100 (another terminal)
pnpm ex smoke         # checks every part end to end
```

Sign in as `leo.martin@kestrelpay.example` with the password `dev-password`. Leo is a finance intern: he can read finance's and HR's documents, and not the board's. Step 00.1 walks through all of this.

## The course map

| #   | Section                   | What you build                                                                                                                                    |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 00  | Tour                      | Run the app, then follow one question from the route to the answer, and one workflow run step by step                                             |
| 01  | Model primitives          | The model interface, a hand-written client for OpenAI's streaming API, the tool-call format, then the AI SDK behind the same interface            |
| 02  | Connectors                | Crawl the drive page by page, back off when it says "slow down", then sync only what changed, deletes and moves included                          |
| 03  | Parsing                   | Read a PDF's text layer, fall back to OCR (reading text out of an image) for scans, turn tables into markdown, keep page numbers                  |
| 04  | Chunking                  | Cut documents into chunks by tokens, with overlap, at headings and between table rows                                                             |
| 05  | Background work           | A Postgres job queue by hand, then ingestion as durable workflow steps, the outbox, fan-out over a 3,000-page filing, fair shares                 |
| 06  | Embeddings and vectors    | Embed in batches, index with HNSW, measure exact against approximate search, then shrink vectors and keep recall                                  |
| 07  | Lexical and hybrid search | BM25 by hand, then Postgres's BM25 index, where keywords beat vectors, a tokenizer change with no downtime, and fusing rankings                   |
| 08  | Rerank and query          | A reranker on the top candidates, query rewriting, HyDE and routing, with honest numbers on when they help                                        |
| 09  | Identity and ACLs         | Who may read what: the group closure, a cache that knows when it's stale, one decision in Postgres, and tenants kept apart                        |
| 10  | Generation and citations  | Fit the sources into a prompt, answer only from them, stream the answer, and check every citation                                                 |
| 11  | Auth and the API boundary | Sessions with organisations as tenants, one middleware for every request, input checks, a rate limiter, streams that stop when the client leaves  |
| 12  | Frontend                  | Server functions in components, a streaming chat with `useChat`, citations that open the page, and an agent run's timeline that survives a reload |
| 13  | Agents: the loop          | Tool calls by hand, a typed tool registry, per-run caps, errors fed back to the model, parallel calls, daily budgets and the kill switch          |
| 14  | Agents: state             | The run as a state machine over an event log, context rebuilt from it, streaming it, two messages at once, compaction and memory                  |
| 15  | Agents: durability        | Checkpoints and resume, idempotent side effects, the run as a Workflow, approvals that wait days, timeouts and cancellation, a replayer by hand   |
| 16  | Agents: orchestration     | Workflows against agents, routing, read-only sub-agents that spend from their parent, schedules that fire once, fan-out with backpressure         |
| 17  | Safety                    | Acting as the user, the poisoned document, plan then execute with an allowlist, guardrails at the server boundary                                 |
| 18  | Evals                     | A golden set, recall@k, MRR and NDCG, claims checked against their sources, a judge calibrated with Cohen's kappa, agent evals in CI              |
| 19  | Observability             | OpenTelemetry traces and metrics, a Grafana dashboard, the cost of each request, the conversation log through the outbox                          |
| 20  | Debugging drills          | Five faults planted in the running app, each with only the symptom a user or an alert would report: find the cause                                |
| 21  | Air-gapped                | Local models through LM Studio, a local reranker scored with a sigmoid, the network cut off, everything vendored                                  |
| 22  | Ship it                   | The app and its workflows on Vercel, ParadeDB on Fly, secrets and migrations, a preview checked end to end, CI and CD                             |

Each section's own `README.md` defines its terms and lists its steps, and its `FINISHED.md` says what to look at once you're done.

## How a step works

A step is two folders, side by side: `01.problem.token-sizing/` holds the task (`README.md`), the file to finish, and the tests; `01.solution.token-sizing/` holds the answer and why it works. Steps are named by section and number: `04.1` is section 04's first step.

1. **Start it.** `pnpm ex start 04.1` copies the problem file into `playground/` and makes the step active. The app now loads your `playground/` copy wherever it would load that module, so the running app, its labs and the tests all use your code. It refuses to throw away unsaved work from another step; `--force` does.
2. **Read the README**, then the hints in `playground/<file>`. They tell you what to write, in order.
3. **Edit `playground/<file>`.** The dev server restarts on each save, so the app picks up your change.
4. **Test it.** `pnpm ex test 04.1` runs the step's tests against your file and prints each failing test's name and why it failed.
5. **Look at it in the lab** (or the app), where the README says. That's where the effect shows: chunks drawn over a page, rankings side by side, a run coming back after a reload.
6. **Compare.** `pnpm ex diff 04.1` shows how your file differs from the solution. Stuck for good? `pnpm ex solution 04.1` puts the solution in `playground/`, and the solution's `README.md` explains it.
7. **Move on** with `pnpm ex start 04.2`. A step's problem file is usually the last step's answer with the next piece missing, so you carry on in the same file.

Other commands: `pnpm ex list` (every step, with your progress), `pnpm ex reset 04.1` (start the step over), `pnpm ex stop` (no step active: the app runs on the reference again), `pnpm ex down` (stop the database). Every command takes `--json`.

## The hints

|     | Means                                                                          |
| --- | ------------------------------------------------------------------------------ |
| 👨‍💼  | Why Kestrel needs this                                                         |
| 🐨  | Do this, one block of work at a time                                           |
| 💰  | A code tip: a function's name, an import, some syntax. Never the answer itself |
| 🦉  | Why it works this way: the mechanism. Read these; they're the lesson           |
| 📜  | Docs worth reading                                                             |
| 🚨  | What the tests check, and the mistake people make most                         |
| 💯  | Extra credit, not tested                                                       |

## Step types

- **graded**: the tests decide when you're done. Most steps are this.
- **guided**: a walkthrough or a comparison, with no pass or fail (the tour, docling in 03.5, workflows against agents in 16.1, `WorkflowAgent` in 16.6, agent task evals in 18.5, metrics and dashboards in 19.2, and all four steps of 22, where you deploy with your own accounts).
- **lab**: done when something shows in the app; the README says exactly what. Section 20's drills are this type: `pnpm ex drill <id>` plants the fault, and `pnpm ex drill check` grades your fix.

## The labs

http://localhost:3000/labs lists them: one page per section, each running the app's own code, so it shows yours while a step of that section is active. Some are dev only: they show other people's access or drive the stand-in drive, so they refuse to run anywhere but dev. Section 00's lab is Workflow's run viewer, at http://localhost:3000/_workflow, and section 12's is the app itself.

## When something's off

- `pnpm ex smoke` names the part that isn't answering.
- "Postgres is unreachable" from `pnpm ex test`: run `pnpm ex up`.
- `PLAN.md` explains why the app is built the way it is; `docs/agent-notes.md` holds the traps in this environment.
