---
title: One middleware for every route
type: graded
slots:
  boundary/middleware: middleware.ts
---

# One middleware for every route

👨‍💼 Kestrel's app has 31 server functions and 14 server routes that act for a user: the chat and its documents, conversations, runs and approvals, memory, the labs. Every one of them must know who's asking before it reads a row, and none may run for nobody. Write that check once, in front of all of them, so no route can forget it.

## Terms

- A **server function** (`createServerFn`) is a function the page calls that runs on the server; a **server route** is a URL with handlers (`POST /api/chat`). Both can name **middleware**: code that runs before the handler and can stop it.
- A **request middleware** is TanStack Start's `createMiddleware().server(fn)`. `fn` gets the `request` and a `next` function: call `next({ context })` to run the handler with `context` added, or return a `Response` to answer without it.
- `getViewer` (`src/lib/auth-server.ts`, your step 1 inside) reads the cookie and returns the viewer, or throws a 401 or 403 `Response`.
- The **bundle** is the JavaScript the browser downloads. The **client build** makes it; the **server build** makes the code that runs on the server.

## Do this

🐨 In `playground/middleware.ts`, write `viewerFrom` (the viewer, or the Response to send) and `viewerMiddleware` (a viewer in the context, or the refusal). `src/lib/middleware.ts` re-exports it, wrapped in the boundary lab's request log, and every route names it.

## A worked example

Leo's browser sends `POST /api/chat` with his cookie. The middleware loads his viewer and calls `next({ context: { viewer } })`; the handler reads `context.viewer` and answers. Without the cookie, `getViewer` throws a 401, the middleware returns it, and the handler never runs.

The same file is compiled for the browser too, because pages import the server functions that name it. Compiled for the browser, the reference keeps one import, `@tanstack/react-start`, and its middleware is a bare `createMiddleware()`. Add one line outside `.server()`, `export const loadViewer = getViewer;`, and the browser build keeps `import { getViewer } from "@/lib/auth-server"`, and everything behind it. Built for production with that line (measured on 18 October), Vite warns 14 times that a Node module was swapped out "for browser compatibility", 8 of them for the `postgres` driver (`net`, `tls`, `crypto`, `stream`...), then the build stops: `[import-protection] Import denied in client environment`, because `getViewer`'s file imports `@tanstack/react-start/server`.

Run the tests with `pnpm ex test 11.2`.
