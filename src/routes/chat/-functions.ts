import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { conversations, runs } from "@/db/schema";
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

/**
 * Makes the conversation an agent run belongs to, if this is its first message (a chat answer makes it the same
 * way). Answers false when the id is someone else's conversation.
 */
export const ensureConversation = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(4000) }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, async (tx) => {
      await tx
        .insert(conversations)
        .values({ id: data.id, tenantId: scope.tenantId, userId: scope.userId, title: data.title.slice(0, 80) })
        .onConflictDoNothing();
      const [own] = await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, data.id), eq(conversations.userId, scope.userId)));
      return own !== undefined;
    });
  });

/**
 * The viewer's agent runs in a conversation, oldest first. `afterMessages` is how many chat messages came before
 * each, so the page can put the run back where it happened.
 */
export const getConversationRuns = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ conversationId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, (tx) =>
      tx
        .select({
          id: runs.id,
          afterMessages: sql<number>`(
            SELECT count(*)::int FROM messages m
            WHERE m.conversation_id = ${runs.conversationId} AND m.created_at < ${runs.createdAt})`,
        })
        .from(runs)
        .where(and(eq(runs.conversationId, data.conversationId), eq(runs.userId, scope.userId)))
        .orderBy(asc(runs.createdAt)),
    );
  });
