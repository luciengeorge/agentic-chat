---
title: Questions in your own words miss the policies
type: lab
---

# Questions in your own words miss the policies

👨‍💼 A ticket from Kestrel's People team:

> The HR policies were re-processed overnight, and the run finished with no errors. Since then, people who ask about them in their own words get worse answers. "My dad died last week. How long can I stay at home?" often misses the Leave Policy now, while "How many days of compassionate leave do I get?", in the policy's own words, still finds it. Nothing was deployed today.

## Plant it

```sh
pnpm ex drill paraphrase
```

Or press **Plant** on this step's page in `/workshop`. It needs ParadeDB. Clear the dev server's terminal once it's back up.

## See it

Sign in as `leo.martin@kestrelpay.example` (password `dev-password`; everyone can read `/HR/Policies`) and ask both questions. Look at the sources each answer used.

## Where to look

- `/labs/lexical`: ask both questions and compare the three lists, BM25, vectors and fused. Which list changed?
- `/labs/rerank`: what reached the reranker for each question.
- The `chunks` table, for the HR policies: what each row holds besides its text.
- Sections 06 and 07: how a vector search finds a chunk, and what it compares a query with.
- `pnpm db:embed`: run it twice and read what it says each time.

🦉 Two questions, one that works and one that doesn't, are a gift: the difference between them is the clue. Ask what each kind of search needs from a chunk to find it, and which of those the overnight run could have changed.

## Done when

`pnpm ex drill check` says **fixed**: every ready HR policy chunk can be found by vector search again, and the fault's test passes. Then `pnpm ex drill reset`.
