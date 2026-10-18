---
title: Delta and webhooks
type: graded
slots:
  connectors/drive-sync: drive-sync.ts
---

# Delta and webhooks: the solution

`fullSync` asks for `latestCursor()` first, makes the report with it, then applies every file of every page the crawl yields. `deltaSync` calls `delta(cursor)`, makes the report with the cursor that comes back, applies each changed file, and skips tombstones. Neither catches anything.

## Why it works

- **The bookmark is set before the crawl.** Every change made while the crawl runs is after the cursor, so the next delta replays it. A change the crawl had already seen is applied a second time, which is harmless: `applyFile` writes the file as it is now, so doing it twice leaves the same row.
- **Each delta moves the bookmark on.** The report carries the source's new cursor. The sync step saves it in `sync_state` in the same transaction as the documents, so a crash before the commit leaves the old cursor and the same changes come again. Nothing is lost and nothing is half applied.
- **An expired cursor shouts.** `ResyncRequiredError` goes up to the sync step, which runs a full sync and starts a fresh cursor. Caught and turned into "no changes", the drive would stop syncing without a word.
- **A webhook just wakes the delta.** The notification carries the subscription id and the `clientState`, nothing about the file. The receiver checks both and queues a delta sync; the delta finds out what changed. A lost notification costs a delay, never a change.

## The worked example

Full sync: 40 created, 40 to ingest. After the three changes, one delta: `files: 3, moved: 1, changed: 1, aclChanged: 1`, one document to ingest (the budget, version 2), and the plan's ACL down to `/Kestrel/Exec`. From the new cursor, nothing.

Two things still go wrong, and the next step fixes them. Delete a file in SharePoint and its document stays in search, because the delta's tombstone is skipped. And rename a folder: Graph's delta lists only the folder and none of the files inside it, so their paths go stale.
