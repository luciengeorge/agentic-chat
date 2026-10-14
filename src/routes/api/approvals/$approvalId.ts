import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { runRoutesDeps } from "@/routes/api/runs/-deps";

import { handleDecideApproval } from "./-approvals";

export const Route = createFileRoute("/api/approvals/$approvalId")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ request, params, context }) =>
        handleDecideApproval(request, scopeOf(context.viewer), params.approvalId, runRoutesDeps()),
    },
  },
});
