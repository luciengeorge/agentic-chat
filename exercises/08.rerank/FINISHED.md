---
title: Rerank and query, done
---

# Rerank and query, done

Every answer Kestrel's assistant gives now goes through code you wrote at both ends of the search. The question is rewritten into three more searches in the documents' own words, with identifiers kept as typed and the question never counted twice. At the other end, Cohere reads the first 30 candidates and hands the chat the best 8, so a page fusion ranked 27th can come first. HyDE and routing are built and off. They stay off, because you measured them:

| Retrieval (golden set, 40 answer questions)  | recall@10 | MRR   | NDCG@10 |
| -------------------------------------------- | --------- | ----- | ------- |
| The default (rewrites, fusion, rerank at 30) | 1.000     | 0.931 | 0.938   |
| With HyDE                                    | 0.988     | 0.931 | 0.928   |
| With routing to 5 documents                  | 0.950     | 0.921 | 0.906   |

(MRR averages 1 over the rank of the first right chunk; NDCG@10 rewards right chunks near the top. Both are section 18's.)

## What to notice in the lab

Open `/labs/rerank`, signed in as anyone (`leo.martin@kestrelpay.example`, password `dev-password`, will do). With `COHERE_API_KEY` set the reranker is Cohere; without it, the overlap reranker the tests use.

- **"What is the hotel limit for a night in London?"** at depth 30: both expenses policies come back, v1 and v2. The reranker can't see that v2 replaced v1 on 1 July; the answer step (section 10) sorts that out from the dates.
- **Set the depth to 8.** The list stops at 8, and every row's "was" is between #1 and #8: the reranker can only shuffle what it reads.
- **Sign in as `sofia.lindqvist@kestrelpay.example` and ask about complaint CMP-2026-01171** at depth 30: the Compliance Monitoring Report's page 3 climbs from the 20s to second, behind the decision paragraph on filing page 845. At depth 8 neither comes back, and the top 8 are all complaints-register tables.
- **The rewrites** are listed above the results. Ask something in your own words ("when can't we ship code over Christmas?", as `sam.patel`) and see the documents' words come back.

Live runs move a few places from the READMEs' numbers: the rewrites are written fresh for each question, and OpenAI's query embeddings aren't bit-identical from call to call.

## What comes next

Section 09 makes sure every candidate the reranker reads, and every chunk the chat quotes, is one the asker may read: the directory, the principal cache, the decision in Postgres, and the wall between tenants. Section 10 then builds the prompt from these 8 chunks.
