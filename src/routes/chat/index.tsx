import { createFileRoute, redirect } from "@tanstack/react-router";

/** A new chat gets its id now; the conversation row appears with its first message. */
export const Route = createFileRoute("/chat/")({
  beforeLoad: () => {
    throw redirect({ to: "/chat/$conversationId", params: { conversationId: crypto.randomUUID() }, replace: true });
  },
});
