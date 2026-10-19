---
title: Workflows vs agents
type: guided
---

# Workflows vs agents

👨‍💼 Kestrel's app already runs two kinds of multi-step work. Ingesting a document is a **workflow**: the same steps, in the same order, every time. Answering "email Tom the terms of KPC-2026-0142" is an **agent**: the model picks each next step from what the last one found. Before this section builds orchestration on both, be able to say which shape a job should take, and why, with numbers from this app.

## Terms

- A **workflow** here means steps whose order is written in code before the job starts. It may call a model inside a step (parsing, embedding), but the model never picks the next step. (Vercel Workflow, the library, can run either shape durably; this is about who decides.)
- An **agent** is a model in a loop (section 13): it chooses the next tool call, the app runs it, and the model reads the result.
- A **router** (step 2) is a third shape: one model call that picks between fixed paths and then steps aside.

## Do this

1. 🐨 Read `ingestWorkflow` in `src/workflows/ingest.ts`. Write down its steps, in order. Which of them could a model have chosen differently?
2. 🐨 Run `pnpm dev`, sign in as `grace.adeyemi@kestrelpay.example` (password `dev-password`), open `/labs/loop` and step through the recording `kpc-terms`, then `search-timeout`. Both ask about the payment terms of KPC-2026-0142. For each model turn, note what it called and what in the previous result made it do that.
3. 🐨 Read `automationWorkflow` in `src/workflows/automation.ts` (it's short). Which parts are fixed, and which are agents?
4. 🐨 For each job, say workflow, agent, or both, and the one fact that decides it:
   - re-ingesting a contract after it was edited in the drive;
   - "Email Tom Whitfield a two-line summary of the payment terms in contract KPC-2026-0142";
   - Grace's Monday digest of /Company (step 4);
   - "every new invoice in /Finance/AP: read its total and supplier, and add a line to the AP tracker";
   - deciding whether a chat message needs the agent at all.

🦉 The question to ask is "do I know the steps before I start?" If yes, write them down in code: a workflow is cheaper (no tokens to choose a step), it can be tested step by step, and it does the same thing every time. If the next step depends on what came back, a model has to choose, and you pay for that with tokens, with turns that can go wrong, and with caps to bound it. Most real systems nest the two.

📜 [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents), Anthropic's note on the same distinction ("workflows are systems where LLMs and tools are orchestrated through predefined code paths")
