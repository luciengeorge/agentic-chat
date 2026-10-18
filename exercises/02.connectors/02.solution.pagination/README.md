---
title: Full crawl with pagination
type: graded
slots:
  connectors/graph: graph.ts
---

# Full crawl with pagination: the solution

`pages` keeps one variable, the next link, starting at the path. While there is one, it requests it, yields the page, and takes the page's `@odata.nextLink`, which is undefined on the last page. `crawlPages` keeps a queue of folders, starting with the root, and a set of ids it has seen. For each folder it reads the children through `pages`; each new item is either queued (a folder) or added to the page's files, and a page with files is yielded.

## Why it works

- **It reads to the end.** The loop only stops on a page without a link, and that page has been yielded first. One request per page, no more, no less.
- **It follows the bookmark.** The link is requested exactly as Graph wrote it. Its `$skiptoken` says "after this item", so a file deleted from a page you've read doesn't shift the next one by a place, as an offset (`$skip=5`) would, and drop a file nobody touched.
- **It visits every folder.** Listing a folder gives you its subfolders, and each of those needs a listing of its own. The queue makes sure each one is listed in turn; Kestrel's root holds only folders.
- **It keeps each file once.** A rename during the crawl can move a file past the bookmark, and the listing then hands it over again. The seen set keeps the first.
- **It yields as it goes.** Each listing page becomes one page of files, so drive sync writes Kestrel's drive in 18 pieces instead of holding all of it, and a crawl of 30,000 files shows progress.

## The worked example

At `$top=5`: 20 requests (18 folders, plus a second page each for the root and `/Company`), 40 files, in 18 non-empty pages. The root's pages carry no files at all: they only feed the queue.

Graph's real page size is 200, and SharePoint folders with thousands of files are common. The bug this step fixes doesn't show up until the drive is big, which is why the tests run at `$top=1` and `2` too.
