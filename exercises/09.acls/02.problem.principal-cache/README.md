---
title: The principal cache
type: graded
slots:
  acl/principal-cache: principal-cache.ts
---

# The principal cache

👨‍💼 Leo Martin's internship in accounts payable ends, and IT takes him out of `/Kestrel/Finance/AP`. The next directory sync removes his three closure rows. Every search he makes from then on must look as if he had never been in AP. But reading his principals from the closure on every request is one more query on the busiest path in the app, so retrieval keeps them in a cache. Your job is to keep that cache honest.

## Terms

- Leo's **principal set** is the ids an ACL could name him by: his own, and every group in his closure. The **pre-filter** (step 4) uses it to pick the documents search looks in.
- The **directory version** is a number per tenant in `directory_versions`. `applyDirectory` bumps it, in the same transaction, whenever a membership or a closure row changes.
- An entry is **stale** when it no longer matches what Postgres holds. **Invalidation** is how a cache finds out.

## Do this

🐨 Write `cachedPrincipals` in `playground/principal-cache.ts`: return the cached set when it was read at the tenant's current directory version; otherwise load it and store it with that version. Everything else in the file is written, and `viewerPrincipals` (`#learn/retrieve/acl`) reads through your function on every search.

## A worked example

Leo's set has 4 ids: himself, AP, Finance and Kestrel. Through them, 18 of Kestrel's 40 documents share something with him: those are his candidates. Two requests, one closure query.

IT removes him from AP. The sync removes 3 closure rows and bumps the version. The next request reads the new number, misses, and loads again: his set is just himself now, and he has 0 candidate documents (nothing in the drive is shared with him by name).

Run the tests with `pnpm ex test 09.2`. They need Postgres (`pnpm ex up`), and run the real directory and drive through fake-workspace.
