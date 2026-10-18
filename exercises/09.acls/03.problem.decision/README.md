---
title: Postgres decides
type: graded
slots:
  retrieve/acl: acl.ts
---

# Postgres decides

👨‍💼 The Project Heron board memo proposes buying Lumen Ledger for £86m. The board votes on 20 October. Daniel Reyes, the CFO, asks about it every day. Leo Martin, the finance intern, must never get a sentence of it, however he words the question. One function decides, for search, citations, the document route and chat history alike.

## Terms

- An **ACL** (access control list) is a document's list of who may read it. Ours lives in `document_acl`: one row per document and principal, with an **effect**, `allow` or `deny`. **Stamping** is sync writing those rows from the drive's sharing (step 5 builds it).
- To **hold** a principal is to be it, or to be in that group by closure (step 1).
- `readable(userId, documentId)` returns a piece of SQL, a true-or-false expression, that the caller puts inside its own query. **Postgres as the decision point** means this expression, evaluated by the database next to the rows, is the only place access is decided.
- An **alias** is the short name a query gives a table (`documents d`). A **subquery** inside an expression can see the outer query's aliases too.

## Do this

🐨 Write `readable` in `playground/acl.ts`. The rest of the file is written: `canRead` asks it about one document, and `decideChunks` (step 4) asks it about every candidate in one statement.

## A worked example

The full sync stamped Kestrel's 40 documents. The memo has one row: `/Kestrel/Exec`, `allow`. Daniel is a direct member of Exec, so he holds it; Leo holds AP, Finance and Kestrel, and none of them has a row on the memo.

| Who          | Principals they hold                          | Documents they may read |
| ------------ | --------------------------------------------- | ----------------------- |
| daniel.reyes | himself, Exec, Finance, Kestrel               | 25 of 40, the memo too  |
| leo.martin   | himself, AP, Finance, Kestrel                 | 18 of 40                |
| ella.brooks  | herself, Kestrel                              | 9 of 40                 |
| peter.hall   | himself, FP&A, Finance, Kestrel, but disabled | 0                       |

Run the tests with `pnpm ex test 09.3`. They need Postgres (`pnpm ex up`).
