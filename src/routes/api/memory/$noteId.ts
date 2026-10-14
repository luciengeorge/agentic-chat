import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { deleteNote } from "#learn/agent/memory";
import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

/** `DELETE /api/memory/:id`: forgets one of the signed-in user's notes. Someone else's answers 404. */
export const Route = createFileRoute("/api/memory/$noteId")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      DELETE: async ({ params, context }) => {
        const noteId = z.uuid().safeParse(params.noteId);
        if (!noteId.success) return Response.json({ error: "not_found" }, { status: 404 });
        const scope = scopeOf(context.viewer);
        const deleted = await withTenant(scope.tenantId, (tx) => deleteNote(tx, scope.userId, noteId.data));
        return deleted ? new Response(null, { status: 204 }) : Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  },
});
