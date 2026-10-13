import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { handleChat } from "./-chat";
import { chatDeps } from "./-deps";

export const Route = createFileRoute("/api/chat/")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ request, context }) => handleChat(request, scopeOf(context.viewer), chatDeps()),
    },
  },
});
