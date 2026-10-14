import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { runRoutesDeps } from "./-deps";
import { handleStream } from "./-runs";

export const Route = createFileRoute("/api/runs/$runId/stream")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      GET: ({ request, params, context }) =>
        handleStream(request, scopeOf(context.viewer), params.runId, runRoutesDeps()),
    },
  },
});
