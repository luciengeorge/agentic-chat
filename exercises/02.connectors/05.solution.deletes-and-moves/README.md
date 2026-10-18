---
title: Deletes and moves
type: graded
slots:
  connectors/drive-sync: drive-sync.ts
  connectors/graph-connector: graph-connector.ts
---

# Deletes and moves: the solution

`deleteFile` locks the document's row by its source id. If there's none, or it's deleted already, it returns. Otherwise it deletes the document's chunks, clears its ACL, sets its status to `deleted` with `deletedAt`, and counts it. All of it happens in the sync's transaction.

`changesFor` answers each kind of entry its own way. A tombstone is one `deleted` change. The root is nothing. A folder is crawled again, and each file under it is a `file` change at its path now. A file is read again for its path, and a 404 on that read is nothing.

## Why it works

- **Search forgets at once.** Search reads chunks, so the chunks go in the same transaction as the status. There's no moment when the file is gone from SharePoint and still in the assistant's answers.
- **Nobody keeps access to nothing.** Clearing the ACL removes every grant and bumps the document's `acl_version`, which tells anything that cached who could read it (section 09) that it's stale.
- **The bytes stay.** Blobs are shared by content hash, and a file restored from the recycle bin comes back with the same bytes: `applyFile` sees a deleted document and ingests it again.
- **A delete is idempotent.** The same tombstone comes again whenever a delta is replayed from a cursor that wasn't saved. The second time finds a deleted document and does nothing, so it's counted once.
- **A folder change means its files.** Graph reports the item that changed, and renaming a folder changes only the folder. Its files' paths change anyway, so crawling it again is how they're found. A moved file is read again for the same reason: delta entries carry no path.
- **A race isn't an error.** A file can be deleted between the delta and the read. Its tombstone is in the next delta, so a 404 there is skipped. Anything else still throws: skipping a 403 would lose a real change.

## The worked example

The invoice batch: 2 chunks gone, ACL empty, status `deleted`, blob kept, `deleted: 1`; the same delta again, and a full sync after it, `deleted: 0`. The Reports rename: the delta's one entry is the folder; `changesFor` turns it into two file changes; the report is `files: 2, moved: 2`, `ingest: []`. The checklist's move into `/Exec`: `moved: 1, aclChanged: 1`, ACL now `/Kestrel/Exec`.

That's the whole connector: a crawl that reaches every page, retries that wait as told, deltas that keep their place, and deletes and moves that keep search honest.
