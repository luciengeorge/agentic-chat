---
title: One middleware for every route
type: graded
slots:
  boundary/middleware: middleware.ts
---

# One middleware for every route: the solution

`viewerFrom` returns `await load(request.headers)`; in its `catch`, a `Response` is returned and anything else rethrown. `viewerMiddleware` is `createMiddleware().server(async ({ next, request }) => ...)`: it gets `viewerFrom(request, getViewer)`, returns it when it's a `Response`, and otherwise returns `next({ context: { viewer } })`.

## Why it works

- **One door.** Every route and server function that acts for a user lists `viewerMiddleware`, so there's one definition of "who is asking" and one place it can go wrong. A handler can only run with a viewer in its context.
- **A refusal is an answer.** `getViewer` throws its 401 and 403 as `Response`s. Returning one from the middleware sends it as is and never calls `next`, so the handler doesn't run for nobody. Any other error is a bug or an outage, and goes on as one (a 500), never disguised as "not signed in".
- **The request's own headers.** The cookie comes from the request the middleware was handed, so it answers for exactly that request.
- **The browser gets an empty shell.** The client build strips `.server(...)` and then drops what nothing uses. With `getViewer` referenced only inside, the browser's copy of this file is `createMiddleware()` and one import. A reference that survives (an export, a default parameter, an exported helper) drags `@/lib/auth-server` into the client build, and with it better-auth, Drizzle and `postgres`.

## The worked example

Compiled for the browser, the file imports only `@tanstack/react-start`. With `export const loadViewer = getViewer;` added, it also imports `@/lib/auth-server`; a production build with it warns 14 times about Node modules swapped out for the browser (8 of them `postgres`'s `net`, `tls`, `crypto`...) and fails on TanStack's import protection: `@tanstack/react-start/server` is denied in the client environment. M1 met the same mistake in dev, where it showed up as a page that wouldn't hydrate: the server's HTML arrived, but React never took it over in the browser, so nothing on it responded to a click.

`src/lib/middleware.ts` wraps yours with a dev-only request log (`/labs/boundary`) that runs just outside it, so it sees the 401s you return as well as the requests you let through.
