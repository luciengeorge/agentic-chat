import { useChat, type UseChatHelpers } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { useState } from "react";

import type { ChatUIMessage, SourceRef, StoredUIMessage, Verdict } from "@/components/chat/types";

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
  const queryClient = useQueryClient();
  const [transport] = useState(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: "/api/chat",
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
      }),
  );
  return useChat<ChatUIMessage>({
    id,
    messages: initialMessages as ChatUIMessage[],
    transport,
    onError,
    onFinish: () => void queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });
}

/** What a reply holds so far: its text, the sources it was given, and the validator's verdict once it's in. */
export function replyParts(message: ChatUIMessage): { text: string; sources: SourceRef[]; verdict?: Verdict } {
  let text = "";
  let sources: SourceRef[] = [];
  let verdict: Verdict | undefined;
  for (const part of message.parts) {
    if (part.type === "text") text += part.text;
    else if (part.type === "data-sources") sources = part.data.sources;
    else if (part.type === "data-verdict") verdict = part.data;
  }
  return { text, sources, verdict };
}
