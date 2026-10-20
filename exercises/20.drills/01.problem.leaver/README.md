---
title: Someone off the exec team still reads its documents
type: lab
---

# Someone off the exec team still reads its documents

👨‍💼 A message from Kestrel's IT lead, a few minutes after you plant the drill:

> We took Priya Nair (the CTO) off the exec team this morning. The directory no longer has her in `/Kestrel/Exec`, and the directory sync ran straight after with no errors. But Priya can still get exec-only documents out of the assistant. She asked "What price are we offering for Lumen Ledger?" and it answered from the Project Heron board memo, which only the exec team may read.

This is the worst kind of bug the app can have: someone reads what they shouldn't, and nothing errors.

## Plant it

```sh
pnpm ex drill leaver
```

Or press **Plant** on this step's page in `/workshop`. It needs ParadeDB and fake-workspace running. Clear the dev server's terminal once it's back up.

## See it

Sign in as `priya.nair@kestrelpay.example` (password `dev-password`) and ask the question above.

## Where to look

- `/labs/acls`: pick Priya, search for the memo, and read what the app thinks her groups are, and why the memo is allowed.
- `acl_audit`: what the sync recorded about her, and when.
- `group_members` and `group_closure`, filtered to her: what does each one say?
- The dev server's log after a sync you trigger yourself (`pnpm sync delta kestrel`): what does the directory step say it did?
- Section 09 built every piece of this; its READMEs say what each table is for.

🦉 The question to ask first is "where does the app decide?". Section 09's rule is that Postgres makes the one access decision, at query time. So every clue that matters is in the rows that decision reads: find the row that still says yes.

## Done when

`pnpm ex drill check` says **fixed**: Priya is still out of the exec team in the database, the app's own access check says no to the memo, and the fault's test passes. Then `pnpm ex drill reset`.
