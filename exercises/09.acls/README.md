---
title: Identity and ACLs
---

# Identity and ACLs

Kestrel's drive holds a £86m acquisition plan, an HR grievance, a restricted NDA and the expenses policy, side by side. The assistant has to answer from all of them, and show each person only what the drive lets them open. Harbour Health's documents live in the same tables, and none of them may ever reach a Kestrel user, or the reverse.

This section is the security core of the app. Its rule fits in a line: **Postgres makes the one access decision, at query time; every copy, cache and filter around it can only make search look in too many places, never let something through.**

## Terms

- A **principal** is anyone an ACL can name: a user or a group. The **directory** lists them, and who is a direct member of what.
- The **closure** is every (group, member) pair, at any depth: a member of `/Kestrel/Finance/AP` is in `/Kestrel/Finance` and `/Kestrel` too.
- An **ACL** (access control list) is who may read a document. Ours is `document_acl`, one row per document and principal, `allow` or `deny`. **Stamping** writes those rows from the drive's sharing.
- A **tenant** is one customer (Kestrel, Harbour). **RLS** (row-level security) is Postgres hiding every other tenant's rows from a query.
- An **audit log** is an append-only record: `acl_audit` for every change to who can read what, `retrieval_audit` for every search.

## The steps

1. **Directory sync and the closure** (`directory/closure.ts`). Turn direct memberships into the closure, and check it against Graph's own.
2. **The principal cache** (`acl/principal-cache.ts`). Keep each user's principals between requests, and know the moment they change.
3. **Postgres decides** (`retrieve/acl.ts`). Write `readable()`, the one SQL expression every path asks.
4. **The over-fetch filter** (`retrieve/acl.ts`). A wide, cheap filter inside the search, and the exact decision after it.
5. **The ACL sync and the audit log** (`acl/stamp.ts`). Stamp the drive's sharing on every sync, with a version and a trail.
6. **Tenant isolation** (`acl/tenant.ts`). Scope every transaction to one tenant, so RLS holds.

The examples follow Leo Martin, the finance intern (in AP, so in Finance and Kestrel), and Daniel Reyes, the CFO (in Exec and Finance), around the Project Heron board memo, shared with `/Kestrel/Exec` only. The tests sync the real directory and drive from `world.yaml` into a throwaway database. The lab, `/labs/acls`, searches as any user of either tenant, in dev only.
