---
title: The over-fetch filter
type: graded
slots:
  retrieve/acl: acl.ts
---

# The over-fetch filter: the solution

`candidateDocuments` returns `[]` for no principals; otherwise `SELECT DISTINCT d.id FROM documents d JOIN document_acl a ON a.document_id = d.id WHERE a.effect = 'allow' AND a.principal_id = ANY(...) AND d.status = 'ready'`.

`decideChunks` returns empty lists for no candidates. Otherwise one statement selects every candidate chunk joined to `documents` on `d.id = c.document_id AND d.version = c.document_version`, with its title, path, pages, section, text and `readable(userId, c.document_id) AS allowed`. Then it walks the candidate ids in order: missing means stale and is skipped; allowed goes in `allowed` without the flag; the rest go in `denied`.

## Why it works

- **The search only looks where the viewer might read.** The pre-filter's ids go inside BM25's and the vector search's WHERE clauses, so their 40 each are spent on chunks that could come back. Without it, Leo's 40 are Heron chunks, and deciding after the limit leaves him nothing.
- **Wide is safe; narrow isn't.** The pre-filter skips `enabled`, `deny` and the live closure. Each of those can only add documents to the list, and the decision takes them out again. Leaving a readable document out would lose it with no error, so the test checks all 31 users: never narrower than `readable()`.
- **Every refusal is written down.** The decision is a column, not a WHERE, so `denied` lists exactly what was refused, and the audit row stores it. A stale cache shows up as denied ids, not as a leak.
- **One statement, one snapshot.** All 60 candidates are decided against the same ACL rows, in one round trip, and the order fusion chose survives for the reranker.

## The worked example

Leo's Heron question searched inside his 18 documents: 0 denied, 8 returned, none from `/Exec`. The same search over all 40 documents would fuse 60 candidates of which 40 are denied, and its first 8 are all `/Exec` chunks. Daniel gets the memo first.

With Leo's closure deleted by hand and his cached set stale, the pre-filter searched his old 18 documents and the decision refused all 60 candidates: 0 returned, 60 in `denied_ids`. Peter Hall, disabled, gets nothing for any question. That's the whole guarantee: the cache, the pre-filter and the over-fetch only move recall and cost, and `readable()`, in Postgres, has the last word on every chunk.
