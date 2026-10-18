---
title: Connectors
---

# Connectors

Kestrel's documents live in its SharePoint: 40 files in 18 folders, each folder shared with a few groups. The assistant can only search what the app has copied, so a **connector** keeps a copy of that drive in Postgres: every file's name, path, content hash and who may read it, plus the content itself for ingestion. It has to stay right while people rename, move, reshare and delete things, and while SharePoint tells it to slow down.

In this course `fake-workspace` (port 8100) plays SharePoint. It speaks the same API, Microsoft Graph, over the corpus in `fixtures/corpus`, and its control API (`/_control/*`) lets you break it on purpose.

## Terms

- A **drive item** is Graph's word for a file or a folder. Each has a stable **id**, a **name**, a parent, and an **eTag**, a tag that changes whenever anything about the item does.
- A **crawl** (or full sync) lists every item, folder by folder. A **listing** comes back in **pages**; each page but the last ends with an `@odata.nextLink`, the address of the next one.
- **Throttling** is the source refusing a request because you're sending too many: HTTP status **429**, often with a **`Retry-After`** header saying how long to wait.
- A **delta** is "what changed since my bookmark". The bookmark is a **cursor** (Graph calls it a delta link). A **webhook** is the source calling the app to say "something changed: look again".
- A **tombstone** is a delta entry that says an item was deleted.
- A **document**, here, is the app's row for one file (`documents` table), with its **version** (bumped when the content changes) and its **ACL**, the list of people and groups who may read it.

## The steps

1. **The connector interface.** Turn a Graph drive item and its permissions into the shapes drive sync understands.
2. **Full crawl with pagination.** Follow every listing to its last page.
3. **429 and `Retry-After`.** Wait as long as the source asks, and give up when waiting won't help.
4. **Delta and webhooks.** Take the bookmark at the right moment, and read only what changed.
5. **Deletes and moves.** Take deleted files out of search at once, and follow a renamed folder's files.

The lab, `/labs/connectors`, is a control panel for fake-workspace: throttle it, pin its clock, watch its webhook deliveries, and crawl it with your code.
