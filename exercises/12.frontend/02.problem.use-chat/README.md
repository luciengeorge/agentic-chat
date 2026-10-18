---
title: Streaming chat with useChat
type: graded
slots:
  frontend/chat: chat.ts
---

# Streaming chat with useChat

👨‍💼 Searching Kestrel's documents takes about three seconds, and the model thinks for a few more before its first word. If the page sat blank all that time, Leo would think it had broken. So the chat shows what's happening ("Searching your documents…", then "Reading 8 sources…"), and then the answer, word by word, as the model writes it.

## Terms

- **`useChat`** is the AI SDK's React hook for a chat. It holds the conversation's **messages**, sends a new one through a **transport**, and updates the last message as the reply streams in. Its `status` says where it is: `submitted`, `streaming`, `ready` or `error`.
- A **transport** decides what goes over the wire. `DefaultChatTransport` posts to a URL, and `prepareSendMessagesRequest` lets you choose the body.
- A **UI message stream** is what `POST /api/chat` sends back: server-sent events, each one JSON. `start`, then `data-sources` (the sources the model was given), `text-start`, one `text-delta` per piece of text, `text-end`, `data-verdict` (the citation validator's verdict), `finish`.
- A message is a list of **parts**. `useChat` turns the stream into parts: one `text` part whose text grows with each delta, and one part per data event (`data-sources`, `data-verdict`).

## Do this

🐨 In `playground/chat.ts`, write `useAnswerChat`, the chat page's `useChat`, and `replyParts`, which reads a reply's parts for the page. The hints in the file walk you through both.

🚨 The classic mistake is adding the reply yourself. `useChat` already puts the answer into `messages` as it streams. An `onFinish` that adds the finished message again shows every answer twice. `onFinish` is for what happens around the answer: here, telling the sidebar its list changed.

## A worked example

The recorded answer to "What's the daily meal allowance on a work trip?" is 13,286 bytes in 158 reads. Read 0 holds `start`: the page says "Searching your documents…". Read 1 comes 3.2 seconds later with 8 sources: "Reading 8 sources…". Read 2, at 6.7 seconds, holds the first word, "For". By read 21 the page shows "For costs incurred on or after 1 July 2026, the daily meal allowance is \*\*£40": the bold's closing asterisks haven't arrived yet, so for a moment the opening ones show as text. The 161 deltas add up to 581 characters, the verdict arrives at 7.19 seconds, and `finish` at 7.22.

## In the app

Sign in as `leo.martin@kestrelpay.example` (password `dev-password`), start a new chat and click the suggestion "What's the daily meal allowance on a work trip?". Watch the status line change twice, then the answer write itself out, with grey number chips that take on colour once the verdict is in. Open the network tab: one request to `/api/chat`, and its request body holds only `id` and `message`. Ask a follow-up, and the body still holds only the new message.

Run the tests with `pnpm ex test 12.2`.
