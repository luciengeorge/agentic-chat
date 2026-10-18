// 👨‍💼 The app has dozens of server functions and routes: the chat, its documents, runs, approvals, the labs. Each
//    one acts for somebody, and each must know exactly who before it touches a row. This file is the one door they
//    all go through.

/**
 * The server boundary (section 11.2). Every server function and server route that acts for a user runs behind this
 * one middleware: it loads the session and the viewer's tenant (from their membership, never from the request), or
 * answers 401 or 403 before the handler runs. Handlers read `context.viewer`.
 */
import { createMiddleware } from "@tanstack/react-start";

import type { Viewer as RetrievalViewer } from "#learn/retrieve/types";

import { getViewer, type Viewer } from "@/lib/auth-server";

/** The viewer for a request, or the 401 or 403 Response `getViewer` throws. */
export async function viewerFrom(
  request: Request,
  load: (headers: Headers) => Promise<Viewer>,
): Promise<Viewer | Response> {
  // 🐨 Call `load` with the request's headers (they carry the cookie). A Response it throws is the answer to send:
  //    return it. Anything else is a real failure (the database is down): let it through.
  //
  // 💰 `error instanceof Response`.
  throw new Error(`viewerFrom(${request.url}, ${typeof load}) isn't written yet`);
}

// 🐨 Make `viewerMiddleware` a request middleware whose server function gets the viewer for its `request` through
//    `viewerFrom` and `getViewer`. A Response means stop: return it, and the handler never runs. A viewer means go
//    on: call `next` with the viewer in the context, and return what it returns.
// 🐨 The classic mistake: referencing `getViewer` anywhere outside the function you pass to `.server()`. Not in a
//    default parameter (`load = getViewer`), not in an exported helper, not in a module-level constant: only inside.
//
// 💰 `createMiddleware().server(async ({ next, request }) => { ... })`; `return next({ context: { viewer } })`.
//
// 🦉 Why one middleware. Every server function and server route that acts for a user names this one in its
//    `middleware: [...]`, so they can't disagree about who's asking. A handler that runs has a viewer; one that
//    didn't get one never ran. Thirty-odd routes each loading the session their own way would be thirty places to
//    forget a check.
// 🦉 Why `.server()` matters for the bundle. This file is imported by pages too: a page names a server function,
//    and the server function names this middleware. So it's compiled twice, once for the server and once for the
//    browser. For the browser, TanStack Start's compiler cuts out everything inside `.server(...)`, then drops any
//    code and import nothing uses any more. Keep `getViewer` inside, and the browser build forgets
//    `@/lib/auth-server` and everything behind it. Leave one live reference outside, and the browser bundle imports
//    better-auth, Drizzle and the `postgres` driver, which needs Node's `net` and `tls`. It broke hydration on this
//    app once, found live.
// 🦉 Why the request's headers. A server route's handler gets the request; `getViewer()` with no argument reads
//    the headers of whatever request is current. Passing the request you were given makes the middleware say which
//    request it answered for, and lets a test call it.
//
// 📜 https://tanstack.com/start/latest/docs/framework/react/guide/middleware
//
// 🚨 The tests check a viewer goes into the context and the handler runs, a 401 or 403 is returned with the
//    handler never called, other errors get through, the request's own headers are used, and that compiled for the
//    browser your file imports nothing but `@tanstack/react-start`.
export const viewerMiddleware = createMiddleware().server(async ({ next, request }) => {
  throw new Error(
    `viewerMiddleware (${request.url}, ${typeof next}) isn't written yet: getViewer is ${typeof getViewer}`,
  );
});

/** The two ids retrieval and the database need. */
export const scopeOf = (viewer: Viewer): RetrievalViewer => ({ tenantId: viewer.tenant.id, userId: viewer.userId });
