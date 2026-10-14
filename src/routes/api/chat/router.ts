import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { handleRouteMessage } from "./-router";
import { routerDeps } from "./-router-deps";

export const Route = createFileRoute("/api/chat/router")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ request, context }) => handleRouteMessage(request, scopeOf(context.viewer), routerDeps()),
    },
  },
});
