---
title: Server functions in components
type: graded
slots:
  frontend/queries: queries.ts
---

# Server functions in components: the solution

`loadConversationPage` checks the id with `z.uuid()` and throws `notFound()` before it calls anything. Then it starts `getConversation` and `getConversationRuns` together inside one `Promise.all`, and returns the conversation with the runs beside it. `useConversations` is one line: `useQuery` under the key `["conversations"]`, with `getConversations()` as the function that fetches.

## Why it works

- **The loader runs before the page draws.** The router waits for it, then draws the page once, with the messages in it. On the first visit that happens on the server: there a server function is a plain call into the database, and the HTML is sent with the answer already written. After that the loader runs in the browser, where each server function is one HTTP request to `/_serverFn/...`. The app preloads on hover, so a click often finds the data waiting.
- **Two requests started together take as long as the slower one.** `Promise.all` starts both before waiting. Awaiting one, then the other, would add their times.
- **A bad id never reaches the server.** `/chat/hello` is a 404 the router can answer by itself. Asking the server first would cost a round trip, only to get a validation error back.
- **The cache is the shared copy.** The first component to call `useQuery(["conversations"])` starts the request; any other that asks while it's in flight shares it. A component drawn later, say the sidebar on `/inbox` after you came from `/chat`, gets the cached list on its very first draw, then refreshes it quietly in the background.
- **The key is how the app talks about the data.** When an answer finishes, the chat calls `invalidateQueries({ queryKey: ["conversations"] })`. Every query under that key is marked out of date, and the ones on screen fetch again. That one line is all the chat needs to know about the sidebar.

## Why not `useEffect`

An effect runs after the component has drawn. So the first draw is always empty, the server can't send the data with the page, and each component that has the effect fetches its own copy. The list then lives in that one component's state, where no other part of the app can reach it to say "this changed".

## The worked example

Leo's sidebar starts with 49 conversations. He asks "What's the daily meal allowance on a work trip?" in conversation `03a8350d`. When the answer is in, the chat invalidates `["conversations"]`; `getConversations` runs once more and returns 50, with the new question first and a link to `/chat/03a8350d-...`. Reloading that page, the loader's two calls come back with the title, 2 messages (`user`, then `assistant`) and no runs.
