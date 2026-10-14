import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { handleSetEnabled } from "./-automations";
import { automationDeps } from "./-deps";

export const Route = createFileRoute("/api/automations/$automationId")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      PATCH: ({ request, params, context }) =>
        handleSetEnabled(request, scopeOf(context.viewer), params.automationId, automationDeps()),
    },
  },
});
