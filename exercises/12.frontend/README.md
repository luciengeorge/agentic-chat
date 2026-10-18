---
title: Frontend
---

# Frontend

Everything Kestrel's assistant does reaches people through one page: the chat. Leo Martin, a finance intern, asks how much he can claim for meals on a work trip. The words of the answer appear while the model is still writing them. Each claim carries a small numbered chip, and the chip opens the policy at the page it came from. When he asks the agent to email a colleague, the page shows each step it takes and waits for his approval before anything goes out, even if he closes the tab and comes back the next day.

None of that is the model's work. It's the browser's: what it asks the server for, when, and what it does with the answer as it arrives. This section writes those pieces.

## Terms

- A **component** is a function that returns what a part of the page shows. A **hook** is a function a component calls (its name starts with `use`) to get data or state that can change; when it changes, the component draws itself again.
- A **server function** is a typed call from the page to the server, made with TanStack Start's `createServerFn`. On the server it's a plain function call. In the browser, TanStack Start turns it into an HTTP request for you.
- A **loader** is the function a route runs before its page renders. On the first visit it runs on the server, so the HTML arrives with the data in it. After that it runs in the browser, when you follow a link or even hover one.
- A **query** is data that TanStack Query fetches and keeps in a **cache**, filed under a **key** such as `["conversations"]`. Every component that asks with the same key shares one request and one copy.
- A **stream** is a reply that arrives in pieces. The chat's answer is a **UI message stream**: server-sent events (one-way messages from server to browser over plain HTTP) that the AI SDK's `useChat` hook turns into a message, piece by piece.
- An **`EventSource`** is the browser's own reader of server-sent events. If the connection drops, it reconnects by itself and sends a `Last-Event-ID` header naming the last event it got.

## The steps

Each step has its own small module behind a `#learn/frontend/...` import, which the components use. The components themselves stay as they are.

1. **Server functions in components.** Load the conversation page in its route's loader, and the sidebar's list with a query.
2. **Streaming chat with `useChat`.** Wire `useChat` to the chat's stream, and read the reply's parts as they arrive.
3. **Citation to the page viewer.** Number the citation chips, and open the cited document at its page.
4. **The run timeline and approval inbox.** Follow an agent run's events, and come back after a reload without losing or repeating one.

The lab is the app itself, at http://localhost:3000/chat. Each step's README says what to click and what you should see. The tests replay two recordings made through the app, signed in as `leo.martin`: the meal allowance answer and an agent run that emails Tom Whitfield a contract's payment terms (`fixtures/cassettes/frontend/`). Nothing in this section calls a model.
