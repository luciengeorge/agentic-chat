---
title: The connector interface
type: graded
slots:
  connectors/graph-connector: graph-connector.ts
---

# The connector interface: the solution

`toSourceFile` reads the hash with `sha256Of` (lower-case hex) and throws if the item has no `file` facet or no hash. Then it copies the id and name, takes the path it's given, the MIME type from `file.mimeType`, and the eTag as the version. `grantedIds` puts the user or group id of every permission into a set, skipping those with neither, and returns it sorted.

## Why it works

- **Three things change at three speeds.** The id never changes, so drive sync finds a file's document by it. The eTag changes on any change, sharing included, so drive sync can tell a file was touched. The content hash changes only with the bytes, so only new bytes cost a parse, a chunk and an embedding.
- **The hash compares, so it has one spelling.** Stored blobs are keyed by lower-case hex. Graph's upper-case hash would never match one, and every sync would ingest all 40 files again.
- **The ACL is everyone who may open the file.** Graph's list is the effective one, inherited grants included, and a writer can always read. Drop either and people lose documents they're allowed to see.
- **What can't be checked grants nothing.** A sharing link names nobody, so it gives search access to nobody. The set and the sort make the list the same whatever order Graph sends, so an unchanged ACL looks unchanged.
- **Folders aren't documents.** Throwing on one keeps a bug (a crawl that yields folders) loud instead of filling the table with empty rows.

## The worked example

The Integration Plan's two permissions, the Exec group's inherited write and Tom's own read, give `[<Exec group>, <Tom>]`; the board memo gives just the Exec group. Renamed, the plan keeps its id and hash, and gets a new path and eTag. The crawl gives 40 source files, every hash 64 lower-case hex digits.

Notice what you didn't write: anything about pages, retries or deltas. `graphConnector` borrows those from the Graph client, which is where the next three steps go.
