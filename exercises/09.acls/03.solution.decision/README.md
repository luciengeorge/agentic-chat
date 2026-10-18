---
title: Postgres decides
type: graded
slots:
  retrieve/acl: acl.ts
---

# Postgres decides: the solution

`readable` is four clauses joined with AND. `EXISTS` a user principal with the id that's enabled. `EXISTS` the document, ready. `EXISTS` an `allow` row on the document whose principal is enabled and held by the user. `NOT EXISTS` a `deny` row on the document whose principal the user holds. "Held" is `holds(userId, acl_a.principal_id)`: the principal is the user, or in `group_closure` above them. Every table inside is named with an `acl_` prefix.

## Why it works

- **One expression, everywhere.** Retrieval puts it in the statement that loads the candidates, `canRead` selects it for one document, routing filters cards with it, and the chat history filter drops stale sources with it. They can't disagree, because there is only one.
- **It reads the live rows.** The closure, `enabled` and the ACL rows are read in the same statement as the search, so a sync that commits is in force for the next query. Nothing is cached here.
- **It fails closed.** A user the tenant doesn't know, a disabled one, a document that's ingesting or deleted, a grant that names nobody it can find: each makes an EXISTS false, and false means no. No branch says yes by default.
- **Its aliases can't be captured.** Postgres resolves a name in a subquery to the nearest table with that name. With `acl_` on every table inside, a caller's `d.id`, `a.id` or `p.id` can only mean the caller's table.

## The worked example

The memo's ACL is one `allow` row for `/Kestrel/Exec`. Daniel holds Exec directly: true. Leo holds AP, Finance and Kestrel: false. Over all 40 documents, Daniel may read 25, Leo 18, Sam Patel 15, Ella Brooks 9. Peter Hall left: his principal is disabled but his three closure rows remain, and he reads 0.

Take `/Kestrel/Finance` out of service (disable the group), and Leo loses the contract register (shared with Finance and Legal) but keeps AP's invoice batch (shared with AP as well). Add a `deny` on AP to the travel policy, and Leo loses it while Tom Whitfield, in Finance but not AP, keeps it.
