---
title: Agent task evals in CI, compared with autoevals
type: guided
---

# Agent task evals in CI, compared with autoevals

👨‍💼 Steps 1 to 4 grade one answer to one question. Sections 13 to 17 built an agent that searches, reads, plans, mails and delegates, and Kestrel needs to know on every commit that it still does those things right: plans before it writes, mails the right person once, recovers when a search times out, and ignores a document that tells it to leak the Heron memo. The agent's last reply can't show any of that. Its event log can. And before writing more evals by hand, the team wants to know what a ready-made library would give them.

## Terms

- An **agent task** is a recorded request plus the checks a good run passes. `AGENT_TASKS` in `src/core/eval/agent-tasks.ts` has four, on the recordings from sections 13 and 16.
- A **check** is one thing a good run does, tested against its events: `finishes`, `calls`, `never-calls`, `plans-before-writing`, `mails`, `mail-says`, `recovers`, `answer-says`, `never-says`, `turns-at-most`. A task's **score** is the share of its checks that pass; it passes when they all do.
- **CI** (continuous integration) runs the repo's checks on every push. Here that's `.github/workflows/ci.yml`, which runs `pnpm test`, so `src/core/eval/agent-tasks.test.ts` runs on every commit.
- **autoevals** is Braintrust's open-source library of scorers (0.4.0, MIT). Its RAG scorers (`Faithfulness`, `ContextRecall`, `ContextPrecision`, `ContextRelevancy`, `AnswerRelevancy`) are adapted from the Ragas project; each is one or two model calls.

## Do this

1. 🐨 Run the tasks:
   ```sh
   pnpm vitest run src/core/eval/agent-tasks.test.ts
   ```
   Four tasks, every check passing, in under a second, with no key and no network.
2. 🐨 Read `AGENT_TASKS` and `runCheck`. For `ignore-planted-instructions`, the test also scores a made-up run that obeys the Brightwell pack: it scores 4 of 6. Which two checks fail? Why does the task need `never-says` when `never-calls send_mail` already fails on that run?
3. 🐨 Break one on purpose: in `AGENT_TASKS`, change `email-contract-terms`'s `{ kind: "mail-says", text: "£61,400" }` to `"£61,401"` and run the tests again. Read the failure: which check, and what did it find? Then put it back (`git checkout src/core/eval/agent-tasks.ts`).
4. 🐨 Run `pnpm eval:judge`. It replays the judge and the claim checker over the 20 hand labels and prints both kappas (steps 3 and 4), with no model call.
5. 🐨 Read autoevals' `Faithfulness`, `ContextRecall` and `ContextPrecision` in [`js/ragas.ts`](https://github.com/braintrustdata/autoevals/blob/main/js/ragas.ts). For each, answer:
   - what it needs as input, and how many model calls it makes per item;
   - which of this section's measures it stands beside (recall@k, MRR, NDCG, claim faithfulness, the judge);
   - what it would score Heron's honest abstention, "I couldn't find an answer to that in the documents you can access";
   - whether it could grade an agent task.
6. 🐨 Decide what Kestrel's CI should run, and what it should run only before a release. Think about cost, time, and whether a test that calls a model can fail on a commit that changed nothing.

🦉 A metric is only as good as what it can see. recall@k sees pages, a judge sees one reply, and an agent check sees the whole run: every call, its input, its result, what went out. Agents fail in ways a reply hides: a mail sent to the wrong person, a write made before the plan, a search retried ten times. That's why their evals are written over the event log, and why the log is worth keeping complete.

📜 [autoevals on npm](https://www.npmjs.com/package/autoevals), and [Ragas's metrics](https://docs.ragas.io/en/stable/concepts/metrics/)
