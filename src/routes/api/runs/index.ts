import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { runRoutesDeps } from "./-deps";
import { handleStartRun } from "./-runs";

export const Route = createFileRoute("/api/runs/")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ request, context }) => handleStartRun(request, scopeOf(context.viewer), runRoutesDeps()),
    },
  },
});
