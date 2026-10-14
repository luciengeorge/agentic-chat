import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { handleRunNow } from "./-automations";
import { automationDeps } from "./-deps";

export const Route = createFileRoute("/api/automations/$automationId/run")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      POST: ({ params, context }) => handleRunNow(scopeOf(context.viewer), params.automationId, automationDeps()),
    },
  },
});
