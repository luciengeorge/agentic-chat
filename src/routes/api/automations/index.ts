import { createFileRoute } from "@tanstack/react-router";

import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { handleCreateAutomation, handleListAutomations } from "./-automations";
import { automationDeps } from "./-deps";

export const Route = createFileRoute("/api/automations/")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      GET: ({ context }) => handleListAutomations(scopeOf(context.viewer), automationDeps()),
      POST: ({ request, context }) => handleCreateAutomation(request, scopeOf(context.viewer), automationDeps()),
    },
  },
});
