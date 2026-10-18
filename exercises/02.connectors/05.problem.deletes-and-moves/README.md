---
title: Deletes and moves
type: graded
slots:
  connectors/drive-sync: drive-sync.ts
  connectors/graph-connector: graph-connector.ts
---

# Deletes and moves

👨‍💼 Leo in accounts payable deletes a scanned invoice batch from SharePoint: it holds a supplier's bank details by mistake. Your step 4 sync skips the delete, so Kestrel's assistant keeps quoting it. Later, Finance renames its Reports folder to Board Reports, and the two reports inside keep their old paths, because Graph's delta only mentions the folder. This step fixes both.

## Terms

- A **tombstone** is a delta entry with `deleted` set: the item is gone, and all that's left is its id.
- A document's **chunks** are what search reads (section 04). A document with chunks can be found, whatever its status says.
- A **blob** is a document's raw bytes, stored once per content hash (`document_blobs`).
- A **move** changes an item's parent; a **rename** its name. Either way its id stays, and so does its document.

## Do this

🐨 Two files. In `playground/drive-sync.ts`, write `deleteFile`: take one document out of search. In `playground/graph-connector.ts`, write `changesFor`: turn one delta entry into the changes drive sync applies, folders included. The hints in each file say how.

## A worked example

After a full sync and an ingest, the invoice batch has two chunks and a blob. Leo deletes it. The next delta holds its tombstone; `deleteFile` deletes both chunks and its ACL and marks the document deleted, and the report says `deleted: 1`. The blob stays. Read the same delta again (as after a crash before the new cursor was saved) and it deletes nothing more: the document already is.

Rename `/Finance/Reports` to "Board Reports" and Graph's delta lists one entry, the folder, and not the two reports in it. `changesFor` crawls the folder: two file changes at their new paths. The report says `files: 2, moved: 2`, nothing to ingest, and both documents keep their ids.

Move the month-end checklist from `/Finance` into `/Exec` and it's one file: new path, version still 1, and an ACL that changes from Finance and Tom to the Exec group, whose folder it now inherits from.

Run the tests with `pnpm ex test 02.5`.
