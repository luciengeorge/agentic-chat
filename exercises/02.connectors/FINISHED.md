---
title: Connectors, done
---

# Connectors, done

Kestrel's drive now reaches Postgres the way it should. Your adapter turns Graph's items into source files and its permissions into ACLs, inherited grants included. Your crawl follows every listing to its last page, 20 requests for 40 files at `$top=5`. Your client waits exactly as long as SharePoint asks, and gives up on what waiting can't fix. Your syncs set the bookmark before the crawl and move it on with each delta. And a deleted file leaves search in the same transaction, while a renamed folder's files follow it.

## What to notice in the lab

Open `/labs/connectors` with fake-workspace running (`pnpm fake-workspace`). It talks to the real one on port 8100, so what you do there is what the app's sync sees.

- **Crawl at `$top=5`**: 20 requests, 40 files. Set `$top` to 2 and it's 33.
- **Add a throttle** (after 6 requests, 2 times, `Retry-After` 3) and crawl again: requests 7 and 8 come back 429, and the log shows two waits of 3 s before the crawl finishes. Clear the faults, add one with no count, and watch the crawl give up after its retries with a retryable error.
- **Deliveries**: with the dev server running, `pnpm sync full kestrel` subscribes the app to the drive. Rename a file in the panel and press Flush: the delivery shows each attempt the notification took to reach the app's webhook, and a delta sync starts.
- **Pin the clock** to a date and rename a file: its `lastModifiedDateTime` is the pinned time.

## What comes next

Section 03 parses the bytes `content(fileId)` hands back: PDFs with a text layer, scans that need OCR, tables. Section 05 runs this sync as a workflow, where a `retryable` error from your client becomes a step that tries again later, and where a webhook's "look again" starts a run. Section 09 takes the ACLs you stamped and makes Postgres the place that decides who sees what.
