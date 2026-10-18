// 👨‍💼 An answer takes Kestrel's assistant about seven seconds: three to search, a few for the model to think,
//    then the words. The chat page shows each stage as it happens, and the answer as it's written. This file is
//    the page's side of that stream: the chat it keeps, and what it reads out of each reply.

import type { UseChatHelpers } from "@ai-sdk/react";

import type { ChatUIMessage, SourceRef, StoredUIMessage, Verdict } from "@/components/chat/types";

// 🦉 New in this file: nothing but the two functions. src/components/chat/chat-view.tsx calls useAnswerChat and
//    draws `messages`; src/components/chat/messages.tsx calls replyParts on each reply. The server side is
//    src/routes/api/chat/-chat.ts: read `respond` to see each event it writes, in order.

/**
 * One conversation's chat, streamed from `POST /api/chat`. It starts from the stored messages, sends the
 * conversation id and the new message only (the server keeps the history), and refreshes the sidebar's list once an
 * answer is in.
 */
export function useAnswerChat({
  id,
  initialMessages,
  onError,
}: {
  id: string;
  initialMessages: StoredUIMessage[];
  onError: (error: Error) => void;
}): UseChatHelpers<ChatUIMessage> {
  // 🐨 Make one transport for the life of the component: a DefaultChatTransport that posts to "/api/chat", with
  //    a prepareSendMessagesRequest that sends { id, message } where message is the last of `messages`.
  // 🐨 Return useChat with the conversation's `id`, the stored messages as its starting `messages`, your
  //    transport, `onError`, and an onFinish that invalidates the sidebar's query (["conversations"], step 1).
  // 🐨 That's all onFinish does. useChat already holds the answer: it added the reply when the stream started
  //    and filled it in delta by delta. Don't add the finished message to `messages` yourself, or every answer
  //    shows twice.
  //
  // 💰 import { useChat } from "@ai-sdk/react"; import { DefaultChatTransport } from "ai";
  // 💰 import { useQueryClient } from "@tanstack/react-query"; import { useState } from "react";
  // 💰 const [transport] = useState(() => new DefaultChatTransport<ChatUIMessage>({ api, prepareSendMessagesRequest }))
  // 💰 useChat<ChatUIMessage>({ id, messages: initialMessages as ChatUIMessage[], transport, onError, onFinish })
  //
  // 🦉 Why only the new message. useChat sends every message it holds by default. Kestrel's server keeps the
  //    history itself (it rebuilds the prompt from its own `messages` table), so it takes the newest message and
  //    nothing else, and refuses a body without one. A client's copy of the history is also a client's to edit:
  //    sending it would let a page rewrite what the assistant said before.
  // 🦉 Why the `id`. useChat keeps one chat per id, and the transport puts that id in the body. Pass the
  //    conversation's id, and the server files the answer under it; leave it out, and useChat makes up a new
  //    one, so every question starts a conversation nobody can find.
  // 🦉 Why useState for the transport. A component's body runs on every draw, so `new DefaultChatTransport(...)`
  //    there would make a new one each time. useState's initializer runs once.
  //
  // 📜 https://ai-sdk.dev/docs/ai-sdk-ui/chatbot
  // 📜 https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence
  //
  // 🚨 The tests check what goes in the request body, that the stored messages show before any request, and
  //    that the finished answer shows once while the sidebar's list is invalidated.
  throw new Error(`useAnswerChat(${id}, ${initialMessages.length} messages, ${onError.name}) isn't written yet`);
}

/** What a reply holds so far: its text, the sources it was given, and the validator's verdict once it's in. */
export function replyParts(message: ChatUIMessage): { text: string; sources: SourceRef[]; verdict?: Verdict } {
  // 🐨 Walk message.parts in order. Add up the text of every "text" part. Take `sources` from the
  //    "data-sources" part (its data.sources) and the verdict from the "data-verdict" part (its data).
  // 🐨 Before the sources arrive there are none: start from an empty list. Before the verdict, leave it out.
  //
  // 💰 part.type === "text" ? part.text : ...; part.type === "data-sources" ? part.data.sources : ...
  //
  // 🦉 Why this is called while the reply is still streaming. useChat changes the message at every event, and
  //    the page draws again each time: first a message with no parts (the page says "Searching your
  //    documents…"), then one with its sources ("Reading 8 sources…"), then a text part whose text grows by one
  //    delta per event. So replyParts must make sense of a reply at any point, half written or done. The verdict
  //    comes last, after the text: until it's in, the citation chips show as pending.
  //
  // 🚨 The tests check what the page says at each stage of the recorded stream.
  throw new Error(`replyParts(a message with ${message.parts.length} parts) isn't written yet`);
}
