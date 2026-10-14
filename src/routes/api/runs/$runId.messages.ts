import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { runRoutesDeps } from "./-deps";
import { handleAddMessage } from "./-runs";

export const Route = createFileRoute("/api/runs/$runId/messages")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ request, params, context }) =>
        handleAddMessage(request, scopeOf(context.viewer), params.runId, runRoutesDeps()),
    },
  },
});
