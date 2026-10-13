import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { ChatView } from "@/components/chat/chat-view";

import { getConversation } from "./-functions";

export const Route = createFileRoute("/chat/$conversationId")({
  loader: async ({ params }) => {
    if (!z.uuid().safeParse(params.conversationId).success) throw notFound();
    return getConversation({ data: { id: params.conversationId } });
  },
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.title ? `${loaderData.title} · Kestrel Assistant` : "New chat · Kestrel Assistant" }],
  }),
  component: ConversationPage,
});

function ConversationPage() {
  const { conversationId } = Route.useParams();
  const { messages } = Route.useLoaderData();
  return <ChatView key={conversationId} id={conversationId} initialMessages={messages} />;
}
