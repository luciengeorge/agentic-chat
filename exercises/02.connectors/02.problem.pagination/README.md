---
title: Full crawl with pagination
type: graded
slots:
  connectors/graph: graph.ts
---

# Full crawl with pagination

👨‍💼 The first time Kestrel connects its SharePoint, drive sync has to find every file. Graph won't list a folder in one answer: it sends a page of items and a link to the next. Kestrel's folders are small today, so a crawl that reads one page per folder would look fine in a demo. Then Finance's folder passes 200 invoices and files start to go missing from search, with no error anywhere.

## Terms

- **`$top`** is how many items you ask for per page (the client's `pageSize`). SharePoint sends at most 200.
- **`@odata.nextLink`** is the full address of the next page. The last page doesn't have one.
- A **`$skiptoken`** is what's inside that link: a bookmark meaning "start after this item". Paging by bookmark is called **keyset paging**; paging by count (`$skip=10`) is **offset paging**.
- **Breadth first** means listing every folder at one depth before going deeper: the root, then each of its folders, then theirs.

## Do this

🐨 Write two functions in `playground/graph.ts`: `pages`, which follows a listing's `nextLink`s to the end, and `crawlPages`, which walks every folder and yields each page's files. The hints in the file say how. Retries come in step 3, so for now a refused request just throws.

## A worked example

At `$top=5`, the root holds 7 folders: Company, Engineering, Exec, Finance and HR on page 1, with a nextLink; Legal and Sales on page 2, with none. `/Company` holds 6 files, so it takes two pages too. Kestrel's other 16 folders fit on one page each. So the crawl makes 18 + 2 = 20 requests and finds all 40 files.

Stop after each first page and nothing errors. You just never list Legal or Sales, or `/Company`'s sixth file: 28 files instead of 40.

Run the tests with `pnpm ex test 02.2`.
