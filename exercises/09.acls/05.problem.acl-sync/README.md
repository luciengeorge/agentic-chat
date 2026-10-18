---
title: The ACL sync and the audit log
type: graded
slots:
  acl/stamp: stamp.ts
---

# The ACL sync and the audit log

👨‍💼 On Tuesday, Helen Marsh shares the Heron memo with Leo Martin so he can format its tables. On Wednesday she takes it back. Every sync in between has to put that into `document_acl`, so `readable()` lets Leo in and then out. And when the auditors ask who could read the memo on Tuesday, and which sync gave Leo access, the database has to answer.

## Terms

- **Stamping** turns one file's sharing in the drive (Graph's permissions, own and inherited) into `document_acl` rows. `stampAcl` does it; the drive sync (section 02) calls it for every file it sees.
- An **ACL version** is a number from `acl_version_seq`, one sequence shared by every document. A stamp that changes something draws the next one, and writes it on the document and its rows.
- The **audit log** (`acl_audit`) is append-only: one row per change, with the principals before and after, the version, and the **sync run** that made it. `setSyncRun` puts the run's id on the transaction, as `withTenant` puts the tenant.

## Do this

🐨 Write `stampAcl` in `playground/stamp.ts`. `clearAcl` (for a deleted file), `recordDocumentAcl` and `setSyncRun` (in `#learn/acl/audit`) are written.

## A worked example

A full sync of Kestrel's drive, as run `wrun_full_sync`: 40 files, 40 changes, versions 1 to 40, 40 audit rows naming the run. The memo gets one row: `/Kestrel/Exec`, `allow`, from the `/Exec` folder's "write" grant. A second sync changes nothing and draws nothing: the sequence stays at 40.

Helen shares the memo with Leo, and run `wrun_shared` sees it: the memo is the one change, version 41, and its audit row says before `/Kestrel/Exec`, after `/Kestrel/Exec` and `leo.martin`. `canRead(leo, memo)` is now true.

Run the tests with `pnpm ex test 09.5`. They need Postgres (`pnpm ex up`).
