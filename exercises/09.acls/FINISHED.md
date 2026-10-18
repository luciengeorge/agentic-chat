---
title: Identity and ACLs, done
---

# Identity and ACLs, done

Every search now passes through code you wrote, in this order. The request's transaction is scoped to one tenant with `SET LOCAL`, so RLS hides every other tenant's rows. The viewer's principals come from the cache, reloaded the moment directory sync bumps the version. They pick the candidate documents, a wide filter that runs inside both searches. Then `readable()`, in Postgres, against the live closure, decides every candidate, and the refusals go in the audit row. The rows it decides from were stamped by your sync, each change with a version and a line in `acl_audit`.

Each layer fails safe on its own. A stale cache or a wrong pre-filter makes search look in the wrong documents, and `readable()` still refuses what it shouldn't return. A `readable()` bug can't cross tenants, because RLS sits under it. A forgotten `withTenant` sees nothing at all.

## What to notice in the lab

Run `pnpm dev`, sign in as anyone, and open `/labs/acls` (dev only: it shows other people's access). The default question is "Project Heron acquisition of Lumen Ledger board vote".

- **kestrel / leo.martin**: three groups (AP at depth 1, Finance at 2, Kestrel at 3), 18 of 40 documents readable, the pre-filter searching the same 18. Eight chunks come back, none from `/Exec`, and nothing is denied.
- **kestrel / daniel.reyes**: the Heron memo and the board pack. Same question, his 25 documents.
- **kestrel / peter.hall** (disabled): his old groups still point the pre-filter at 19 documents, so search finds candidates, and `readable()` denies every one. The audit row has them all under denied, and the chat would abstain.
- **harbour / nina.osei**, asking about the London hotel limit: two groups, 5 of Harbour's 6 documents (not `/IT`), and her own travel policy first. "Across the tenant wall": Kestrel has 40 documents, and 0 can be seen from Harbour's transaction.
- **The acl_version mark** in each audit row is the newest ACL change the search could have seen. Share a file with someone through fake-workspace's control API, run `pnpm sync`, and the mark moves on.

The dev database's chunks have real embeddings and the reranker may be Cohere, so the lab's chunks differ from the READMEs' test numbers; the counts of groups and documents are the same.

## What comes next

Section 10 builds the prompt from the chunks the viewer may read, and cites them. Section 11 puts all of this behind one middleware: the tenant comes from the session, never from the request, and every server function goes through it. Section 17 comes back to authorisation for the agent, which acts as the user, with the user's ACLs. Section 20's first drill is a stale ACL: you'll find it from the audit rows.
