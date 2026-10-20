---
title: Kestrel's edits stopped arriving
type: lab
---

# Kestrel's edits stopped arriving

👨‍💼 An on-call page, and the message behind it:

> About two hours ago, changes made in Kestrel's SharePoint stopped reaching the assistant. Edit any Kestrel document and ask about it: the assistant keeps the old text, however long you wait. SharePoint shows every change notification delivered, and Harbour Health's edits still arrive.

## Plant it

```sh
pnpm ex drill stuck-edits
```

Or press **Plant** on this step's page in `/workshop`. It needs ParadeDB, and the dev server running (it runs the relay). Clear the dev server's terminal once it's back up.

## See it

In `/labs/connectors`, signed in as anyone at Kestrel, rename a file. A change in fake-workspace normally reaches the app within seconds: a webhook, a sync request, a sync run, an ingest. Wait, then look for the new name in the app. Do the same as a Harbour Health user (`nina.osei@harbourhealth.example`, same password) to see the difference.

## Where to look

- `/labs/background`: the queue board's outbox rows, by partition, with their attempts and last error. Watch it for a minute.
- The dev server's log: each relay pass says what it published, retried and failed.
- The `outbox` table: `published_at`, `failed_at`, `attempts`, `last_error`, `created_at`, and `partition_key`.
- Workflow's run viewer at `/_workflow`: which sync runs started, for which tenant, and when.
- Section 05 built the outbox and the relay; its step 4 explains partitions.

🦉 "Notifications delivered" and "Harbour still works" are two halves of a search. The first says the webhook side is fine; the second says the relay, the workflows and the database are up. Whatever broke is between them, and only for Kestrel.

## Done when

`pnpm ex drill check` says **fixed**: no Kestrel sync request has been waiting more than a minute, and the fault's test passes. Then `pnpm ex drill reset`.
