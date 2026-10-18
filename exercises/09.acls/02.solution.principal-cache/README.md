---
title: The principal cache
type: graded
slots:
  acl/principal-cache: principal-cache.ts
---

# The principal cache: the solution

`cachedPrincipals` reads `directoryVersion(tx)` first. With no tenant it returns `load(tx, userId)` and stores nothing. Otherwise the key is `${tenantId}:${userId}`; an entry at the current version is returned as it is, and a miss loads the set, stores `{ version, principalIds }` under the key, and returns it.

## Why it works

- **The version moves with the change.** Directory sync bumps `directory_versions` in the transaction that writes the membership, so the bump commits exactly when the new closure does. The first request after it sees a new number. There's no window, as a timer would leave.
- **The version is read first.** A set loaded while a sync commits is filed under the old number, so the next request reloads. Filed under a number read afterwards, an old set would wear the new version until the following sync.
- **One cache, many tenants.** The key holds the tenant, read from the transaction itself (`app.tenant_id`), never from the caller. Outside a tenant's transaction there is no key, so nothing is stored.
- **A cache miss is the safe side.** Every way this can go wrong (a process that missed a bump, a membership edited by hand) makes the set stale, and a stale set only changes where search looks.

## The worked example, and the safety net

Leo: 4 principals and 18 candidate documents, read once for two requests. After the sync that takes him out of AP: 1 principal and 0 candidates, on the very next request.

The last test breaks the cache on purpose: it deletes Leo's closure rows by hand, so nothing bumps the version. The cache still says 4 principals, and the pre-filter still finds 18 documents, the AP invoice batch among them. Then `readable()` checks the live closure and refuses the batch. That is the rule section 09 rests on: **a stale cache can over-fetch, never leak**, because Postgres makes the one access decision and the cache isn't part of it.
