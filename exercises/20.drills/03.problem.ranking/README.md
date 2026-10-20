---
title: The answers are a bit off
type: lab
---

# The answers are a bit off

👨‍💼 From Kestrel's support channel, the week of a release:

> Since this week's release, staff say the answers are "a bit off". The right document is usually among the sources, only further down, and now and then the assistant answers from an older one. Ask "What is the London hotel limit now?" and look at the order of the sources. Nothing errors and the logs are quiet. Chat is a little faster than last week, and finance noticed this month's Cohere bill has fallen to almost nothing.

The hardest bugs to find are the ones that don't fail: everything answers, just worse.

## Plant it

```sh
pnpm ex drill ranking
```

Or press **Plant** on this step's page in `/workshop`. It needs `COHERE_API_KEY` in `.env.local` and the hosted models (it refuses with `MODEL_PROVIDER=local`). Clear the dev server's terminal once it's back up.

## See it

Sign in as `leo.martin@kestrelpay.example` (password `dev-password`), ask the question, and open the sources. Version 2 of the travel policy (from 1 July 2026) is the one in force.

## Where to look

- `/labs/rerank`: the same question, every candidate, where fusion put it and where it went. What do the moves and the scores say?
- The support message has three facts besides the ranking. Take each one seriously: what would make chat faster, and the bill fall?
- Cohere's own dashboard, if you have the account, or a scratch script that calls the app's reranker (`rerankerFromEnv()` in `src/lib/retrieval.server.ts`) on two short texts.
- Section 08 built the reranker and `retrieve`; its READMEs say what each stage hands the next.

🦉 "No errors" is a clue, not an alibi. When a part of the system costs less and runs faster, ask whether it's running at all, and if it isn't, where its error went.

## Done when

`pnpm ex drill check` says **fixed**: the app's reranker answers a real rerank call, and the fault's test passes. Then `pnpm ex drill reset`.
