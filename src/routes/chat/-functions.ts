import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";
import { citedChunk } from "@/routes/api/chat/-sources";
import { listConversations, loadConversation } from "@/routes/api/chat/-store";

/** The viewer's conversations, newest first. */
export const getConversations = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .handler(async ({ context }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, (tx) => listConversations(tx, scope));
  });

/** One conversation's messages. A conversation that doesn't exist yet (a new chat) comes back empty. */
export const getConversation = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    const conversation = await withTenant(scope.tenantId, (tx) => loadConversation(tx, scope, data.id));
    return conversation ?? { title: null, messages: [] };
  });

/** A cited chunk's text and its document, for the source panel. Null when the viewer can't read it now. */
export const getCitedChunk = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ chunkId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, (tx) => citedChunk(tx, scope, data.chunkId));
  });
