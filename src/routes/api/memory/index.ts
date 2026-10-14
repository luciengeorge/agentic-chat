import { createFileRoute } from "@tanstack/react-router";

import { listNotes } from "#learn/agent/memory";
import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

/** `GET /api/memory`: the notes the agent keeps about the signed-in user. */
export const Route = createFileRoute("/api/memory/")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      GET: async ({ context }) => {
        const scope = scopeOf(context.viewer);
        const notes = await withTenant(scope.tenantId, (tx) => listNotes(tx, scope.userId));
        return Response.json({ notes }, { headers: { "cache-control": "private, no-store" } });
      },
    },
  },
});
