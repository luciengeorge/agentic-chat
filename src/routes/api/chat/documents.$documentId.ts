import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

import { documentFile } from "./-sources";

/** Inline types the browser shows itself; anything else downloads. */
const INLINE = new Set(["application/pdf", "text/markdown", "text/plain"]);

/** `GET /api/chat/documents/:id`: the original file, for a citation's "open at page" link (`#page=N` in a PDF). */
export const Route = createFileRoute("/api/chat/documents/$documentId")({
  server: {
    middleware: [viewerMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        const documentId = z.uuid().safeParse(params.documentId);
        if (!documentId.success) return Response.json({ error: "not_found" }, { status: 404 });
        const scope = scopeOf(context.viewer);
        const file = await withTenant(scope.tenantId, (tx) => documentFile(tx, scope, documentId.data));
        if (!file) return Response.json({ error: "not_found" }, { status: 404 });

        const inline = INLINE.has(file.mimeType);
        return new Response(Buffer.from(file.bytes), {
          headers: {
            // Markdown as plain text, so the browser shows the source and never renders it.
            "content-type": file.mimeType === "text/markdown" ? "text/plain; charset=utf-8" : file.mimeType,
            "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
