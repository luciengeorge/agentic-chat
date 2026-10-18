---
title: Streaming chat with useChat
type: graded
slots:
  frontend/chat: chat.ts
---

# Streaming chat with useChat: the solution

`useAnswerChat` makes one `DefaultChatTransport` in a `useState` initializer. Its `prepareSendMessagesRequest` sends `{ id, message: messages.at(-1) }`. Then it calls `useChat` with the conversation's id, the stored messages, that transport, `onError`, and an `onFinish` that only invalidates `["conversations"]`. `replyParts` walks the parts once: it adds up every text part, and takes the sources and the verdict from their data parts.

## Why it works

- **`useChat` owns the reply.** When the stream starts, it adds an empty assistant message. Each event changes that same message: `data-sources` adds a data part, each `text-delta` makes the text part's text longer, `data-verdict` adds the verdict. Each change draws the page again. So the page never builds the answer itself, and `onFinish` gets a message that is already on screen. Adding it there would draw it twice.
- **`replyParts` works at any moment.** It's called on a reply with no parts, with sources only, with half its text, and finished. Each stage gives something to show: "Searching your documents…", "Reading 8 sources…", the words so far, then the chips.
- **The body is what the server expects.** The server keeps the history, and its schema wants `id` and `message`. useChat's default body is `{ id, messages, trigger }`, the whole conversation, which the server would refuse.
- **The id ties the stream to the conversation.** useChat's `id` is the one `prepareSendMessagesRequest` receives, so the server files the answer under the conversation in the URL.
- **`onFinish` is the hand-off to step 1.** The sidebar's query is keyed `["conversations"]`; invalidating it is the only thing the chat needs to know about the sidebar.

## The worked example

Leo's answer arrived as 158 reads, 13,286 bytes. Read 0, as the headers arrived, held `start`, so useChat added an empty reply and the page said "Searching your documents…". Read 1, at 3,167 ms, carried the 8 sources: "Reading 8 sources…". Read 2, at 6,668 ms, held the first delta, "For". After read 21 (6,786 ms) the text part read "For costs incurred on or after 1 July 2026, the daily meal allowance is \*\*£40", which the page drew with the asterisks showing: the bold isn't closed yet. The next delta closed it. After all 161, the verdict (7,194 ms) turned the grey, pending chips into ones you can click. `finish` came at 7,217 ms, `onFinish` ran, and the sidebar fetched its list again.

Those 3.5 seconds between the sources and the first word are mostly the model reasoning before it writes. Without the status line, that's 6.7 seconds of a blank reply.
