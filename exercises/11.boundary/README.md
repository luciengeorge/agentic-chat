---
title: Auth and the API boundary
---

# Auth and the API boundary

Sections 09 and 10 made retrieval and answers safe for a viewer: the right tenant, the right documents, checked citations. All of it rests on one question being answered right on every request: who is this viewer? This section builds the server boundary, the code every request crosses before it reaches any of that, and makes it the only way in.

Its rule, from `PLAN.md`: **the session says who, the membership says which tenant, and the request says neither.** Everything the browser sends is checked before anything acts on it, and nothing in it decides whose data is touched.

## Terms

- A **session** is better-auth's record of a sign-in. The browser holds its token in an **httpOnly cookie**, which scripts can't read and every request carries.
- A **tenant** is one customer organization: Kestrel Pay or Harbour Health. A user is a **member** of exactly one.
- The **viewer** is who a request acts for: the user and their tenant, from `getViewer`.
- **Middleware** is code that runs before a route's handler and can stop it. A **server function** is a function a page calls that runs on the server; a **server route** is a URL with handlers.
- **Validation** is checking a request's body against a **schema** (zod) before using it.
- A **rate limit** caps how often someone may ask; a **token bucket** is how this one counts.
- A **stream** is a response sent in pieces. A **heartbeat** keeps a quiet one open; an **abort** stops the work behind one whose reader left.

## The steps

1. **Sessions, with organizations as tenants** (`boundary/viewer.ts`). Turn a better-auth session into the viewer, with the tenant from the membership.
2. **One middleware for every route** (`boundary/middleware.ts`). Put that check in front of every server function and route, without shipping it to the browser.
3. **Validation, and where the tenant comes from** (`boundary/chat-request.ts`). Check the chat request, and never take a tenant or user from it.
4. **A token bucket in Postgres** (`boundary/rate-limit.ts`). Ten questions in a burst, then one every six seconds, safe under concurrency.
5. **Streaming through the boundary** (`boundary/stream.ts`). Heartbeats while quiet; a closed tab aborts the model.

The example is Leo Martin at Kestrel, with Nina Osei at Harbour as the tenant he must never reach. Steps 1, 3, 4 and 5 run on throwaway databases (step 1 seeds the world's users into the real better-auth), so they need Postgres. The lab, `/labs/boundary`, is a log of the last requests through your middleware, with each viewer's tokens left; it runs in dev only.
