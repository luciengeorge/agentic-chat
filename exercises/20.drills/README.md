---
title: Debugging drills
---

# Debugging drills

Some interviews hand you a broken system and a symptom, and watch how you find the cause. This section is practice for that round. Each drill breaks the running app in one hidden place, tells you what a user or an on-call alert would see, and leaves the rest to you. You have the whole app, its labs, its database and its logs; you don't have the diff.

## Terms

- A **symptom** is what someone sees: a wrong answer, a missing update, a job at the wrong time. A **cause** is the line of code or the row of data that makes it happen. One cause can have several symptoms, and the first thing you find is rarely it.
- To **plant** a drill is to put its fault into your running app: `pnpm ex drill <id>` changes code and data, hides the change from git, restarts the dev server, and prints the symptom.
- A **clue** is anything that narrows where the cause can be. A good one rules a whole part of the system in or out.

## How a drill works

1. Have the stack running (`pnpm ex up`, `pnpm dev`, `pnpm fake-workspace`), and start the drill's step (`pnpm ex start 20.1`), so no earlier step's playground stands in for the code a drill changes.
2. Plant it: `pnpm ex drill leaver`, or the **Plant** button on the step's page in `/workshop`. Read the symptom, then **clear the dev server's terminal**: while the server restarts, Vite may print a reload line that names the file the drill changed.
3. Investigate, then fix the cause. After a code change, restart `pnpm dev`, as a deploy would: the relay and the workflow steps don't reload on their own.
4. Grade it: `pnpm ex drill check` (or **Check**). It passes when the symptom is gone _and_ the fault's own test passes against your code.
5. `pnpm ex drill reset` puts the original code and data back, your fix included, before the next drill.

`git status` and `git diff` show nothing while a drill is planted; that's on purpose. The answers are in `src/core/drills/`, `scripts/ex/drill*.ts`, `.ex/` and the M5 contract's "Wave 2, lane D" block: don't read them.

The check grades behaviour, so two things to know. Some faults leave bad data behind, and fixing the code alone won't clear it. And a fix that hides a failure (a catch that carries on, a fallback nobody hears about) can make the symptom go away and still fail the check: it wants errors to surface.

## The toolbox

- **The labs.** `/labs/acls` (anyone's groups, what they can read, the audit row), `/labs/lexical` (one question by BM25, by vectors, fused), `/labs/rerank` (every candidate before and after the reranker), `/labs/background` (the queue board: jobs and outbox rows), `/labs/connectors` (fake-workspace's control panel). `/labs/drills` shows the planted drill's report.
- **The app.** `/chat` with its sources, `/automations`, and Workflow's run viewer at `/_workflow`.
- **The database.** `docker compose exec paradedb psql -U ac ac` opens psql as the owner, which sees every tenant. The tables worth knowing: `acl_audit` and `retrieval_audit`, `group_members` and `group_closure`, `chunks`, `outbox`, `jobs`, `automations` and `automation_fires`.
- **The logs.** The dev server prints a structured line for each sync, relay pass and run.
- **The scripts.** `pnpm sync delta kestrel` asks for a sync; `pnpm db:embed` embeds what's missing. A scratch file run with `pnpm exec dotenv -e .env.local -- tsx scratch.ts` can call any of the app's functions.

## The drills

1. **Someone off the exec team still reads its documents** (`leaver`).
2. **Questions in your own words miss the policies** (`paraphrase`).
3. **The answers are a bit off** (`ranking`).
4. **Kestrel's edits stopped arriving** (`stuck-edits`).
5. **The overnight digest ran at the wrong time** (`digest`).

They're labs: each is done when `pnpm ex drill check` says "fixed". Each solution README gives the cause, the path a good debugger takes to it (what each clue rules out), the fix and the lesson. Read it after the check passes, or when you've stopped making progress.

🦉 A method that works in the interview and on call: reproduce the symptom yourself; say out loud what it rules out; follow the data from a place where it's right to the first place it's wrong; change one thing at a time; fix the cause, then check the symptom is gone.
