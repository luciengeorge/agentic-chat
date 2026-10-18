---
title: Server functions in components
type: graded
slots:
  frontend/queries: queries.ts
---

# Server functions in components

👨‍💼 Leo Martin clicks a conversation in the sidebar. The messages should already be on the page when it appears, without a blank flash first. And when he asks something new, the question should show up at the top of the sidebar the moment the answer is in. Two pieces of code decide both: how the conversation page gets its data, and how the sidebar gets its list.

## Terms

- A **server function** (`createServerFn`) is a typed call to the server. `getConversation({ data: { id } })` looks like a plain function call, and on the server it is one. In the browser, TanStack Start sends it as an HTTP request.
- A route's **loader** runs before its page renders: on the server for the first page load, then in the browser when you follow a link, or hover one (the app **preloads** on hover).
- A **query** (`useQuery` from TanStack Query) fetches data and files it in a **cache** under a **key**. Components that use the same key share one request and one copy. **Invalidating** a key marks it out of date, and every component showing it fetches it again.

## Do this

🐨 In `playground/queries.ts`, write `loadConversationPage`, which the route `/chat/$conversationId` uses as its loader, and `useConversations`, which the sidebar calls. The hints in the file walk you through both.

🚨 The classic mistake is calling a server function from a `useEffect` and keeping the result in `useState`. It works on screen, mostly. But the effect only runs after the page has drawn, so the page appears empty first and never arrives with its data from the server. Two components each fetch their own copy. And nothing else in the app can tell them the data changed. The tests catch each of these.

## A worked example

Leo's sidebar holds 49 conversations. He asks "What's the daily meal allowance on a work trip?" in a new chat, conversation `03a8350d`. When the answer is in, the chat invalidates `["conversations"]`, the sidebar asks `getConversations` again, and the list comes back with 50, his new question on top. Opening that conversation later, the loader asks `getConversation` (the title and 2 messages: his question and the answer with its sources and verdict) and `getConversationRuns` (none) at the same time, and the page renders once both are back.

## In the app

Sign in as `leo.martin@kestrelpay.example` (password `dev-password`) and open http://localhost:3000/chat with your browser's network tab open.

- Hover a conversation in the sidebar without clicking. Two requests to `/_serverFn/...` go out: the loader, preloading. Click, and the page appears with its messages at once.
- View the page's source (not the inspector): the answer's text is in the HTML, because the loader ran on the server.
- Ask a question in a new chat. When the answer finishes, it appears at the top of the sidebar without a reload.

Run the tests with `pnpm ex test 12.1`.
