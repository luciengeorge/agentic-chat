---
title: Delta and webhooks
type: graded
slots:
  connectors/drive-sync: drive-sync.ts
---

# Delta and webhooks

👨‍💼 Tom Whitfield renames the month-end checklist, replaces the budget notes and takes himself off the Heron plan's sharing, all before lunch. Kestrel's assistant should know about all three within seconds, without crawling 18 folders each time. Graph can say what changed since a bookmark, and call the app when something does. This step writes the two syncs that use them: the full one that sets the first bookmark, and the delta that reads from it.

## Terms

- **Drive sync** (`drive-sync.ts`) writes what a `Connector` reports into the `documents` table: a full sync from a crawl, a delta sync from changes.
- A **cursor** is the bookmark. `latestCursor()` gives one for "from now on"; `delta(cursor)` gives the changes since it, and the next cursor.
- **`ResyncRequiredError`** means the cursor is too old for the source to answer from: start again with a full sync.
- A **change notification** is the webhook's message: a subscription id and a **`clientState`**, a secret the app chose when it subscribed, so it can tell Graph's calls from forged ones.

## Do this

🐨 Write `fullSync` and `deltaSync` in `playground/drive-sync.ts`. `applyFile`, which writes one file's document and ACL, is written. Deleted files are step 5's: skip them for now.

## A worked example

A full sync of Kestrel's drive writes 40 documents, all pending, all to ingest, and a cursor ending `/drive/root/delta?token=...`. Then three changes: the checklist is renamed, the budget notes get new bytes, and the plan's own grant to Tom is removed.

The delta from that cursor reports 3 files. The rename is a move (same document, new path, version still 1, nothing to ingest). The budget is a change: version 2, to ingest. The plan's ACL changes from the Exec group and Tom to the Exec group alone. A second delta, from the cursor the first one returned, finds nothing.

Had the full sync taken its cursor after the crawl, a budget uploaded mid-crawl would never show up in any delta.

Run the tests with `pnpm ex test 02.4`.
