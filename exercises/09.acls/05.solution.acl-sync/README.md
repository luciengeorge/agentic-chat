---
title: The ACL sync and the audit log
type: graded
slots:
  acl/stamp: stamp.ts
---

# The ACL sync and the audit log: the solution

`stampAcl` looks up the principals whose `externalId` is one of the grants, keeps their ids sorted and unique, and lists the ids it didn't find as `unknown`. It locks the document (`FOR UPDATE`), reads the `allow` rows it holds, and returns `changed: false` when they're the same set and the document was stamped before. Otherwise it draws `nextval('acl_version_seq')`, deletes the old rows, inserts one `allow` row per principal at the new version, sets `documents.acl_version`, and calls `recordDocumentAcl` with before, after and the version.

## Why it works

- **The rows say what the source says, nothing more.** Read and write grants both become `allow`; who they reach through nesting is the closure's job at query time. A grant nobody can be found for is left out, so it lets nobody in until the directory has the principal.
- **A version means a real change.** Comparing first means a quiet sync draws nothing, so the sequence counts changes to access, in the order they committed, across every document.
- **The trail is written in the same transaction.** The audit row commits with the ACL rows, or neither does. The run id comes from the transaction (`app.sync_run_id`), so `applyFile` doesn't pass it through every call.
- **Concurrent syncs take turns.** The row lock makes a second stamp of the same document wait, then compare against what the first wrote.

## The worked example

Run `wrun_full_sync` stamped 40 documents at versions 1 to 40, each with one audit row, each row allow and at its document's version. The memo's history starts with one stamp: before nothing, after `/Kestrel/Exec`. The quiet sync drew nothing. Shared with Leo, the memo moved to version 41 with the audit row before `/Kestrel/Exec`, after `/Kestrel/Exec` and `leo.martin`, and `readable()` let Leo in on the next query.

Retrieval records `acl_version_seq`'s value in every `retrieval_audit` row. So "could Leo have seen the memo in that answer?" is a query: his retrieval's mark against the memo's history. A mark of 40 is before the share; 41 or more, after.
