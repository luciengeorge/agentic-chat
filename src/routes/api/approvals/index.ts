import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { runRoutesDeps } from "@/routes/api/runs/-deps";

import { handleListApprovals } from "./-approvals";

export const Route = createFileRoute("/api/approvals/")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      GET: ({ request, context }) => handleListApprovals(request, scopeOf(context.viewer), runRoutesDeps()),
    },
  },
});
