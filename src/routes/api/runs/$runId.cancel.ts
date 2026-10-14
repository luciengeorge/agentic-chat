import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { runRoutesDeps } from "./-deps";
import { handleCancelRun } from "./-runs";

export const Route = createFileRoute("/api/runs/$runId/cancel")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ params, context }) => handleCancelRun(scopeOf(context.viewer), params.runId, runRoutesDeps()),
    },
  },
});
