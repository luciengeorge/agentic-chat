---
title: The connector interface
type: graded
slots:
  connectors/graph-connector: graph-connector.ts
---

# The connector interface

👨‍💼 Kestrel keeps its documents in SharePoint today, and its acquisition, Project Heron, brings a Google Drive. Drive sync, the code that copies a source into Postgres, shouldn't care which. So it speaks one small interface, `Connector`, and each source gets an adapter. This step writes the two mappings at the heart of SharePoint's adapter: a file, and who may read it.

## Terms

- **`Connector`** (in `src/core/connectors/types.ts`) is what a source must offer: `crawl()`, `delta(cursor)`, `permissions(fileId)`, `content(fileId)`, and webhook subscriptions.
- A **`SourceFile`** is a file as drive sync sees it: `id`, `name`, `path`, `mimeType`, a `version` that changes when anything about the file does, and a `contentHash` that changes only when its bytes do.
- A **permission** is one grant on a drive item: a role (read or write) for a user or a group. **Inherited** permissions come from a folder above (`inheritedFrom`); **own** ones are set on the item.
- A **sharing link** is a permission with no user or group: anyone holding the link may open the file.

## Do this

🐨 In `playground/graph-connector.ts`, write `toSourceFile` (a Graph drive item to a `SourceFile`) and `grantedIds` (a file's permissions to the ids of the users and groups they name). `graphConnector`, which uses both, is written.

## A worked example

`/Exec/Project Heron Integration Plan v0.4.docx` has two effective permissions. The first is inherited from `/Exec`: the Exec group may write. The second is its own: Tom Whitfield, the financial controller, may read. So `grantedIds` gives two ids, the Exec group's and Tom's, sorted. The board memo beside it has only the inherited one: the Exec group's id alone.

Rename the plan to "v0.5" and its `SourceFile` keeps its id and its content hash (the bytes didn't change), while its path and version (the eTag) both move on. Crawl the whole drive and you get 40 source files out of 18 folders.

Run the tests with `pnpm ex test 02.1`.
