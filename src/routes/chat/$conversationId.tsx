import { createFileRoute } from "@tanstack/react-router";

import { loadConversationPage } from "#learn/frontend/queries";
import { ChatView } from "@/components/chat/chat-view";

export const Route = createFileRoute("/chat/$conversationId")({
  loader: ({ params }) => loadConversationPage(params.conversationId),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData?.title ? `${loaderData.title} · Kestrel Assistant` : "New chat · Kestrel Assistant" }],
  }),
  component: ConversationPage,
});

function ConversationPage() {
  const { conversationId } = Route.useParams();
  const { messages, runs } = Route.useLoaderData();
  return <ChatView key={conversationId} id={conversationId} initialMessages={messages} initialRuns={runs} />;
}
