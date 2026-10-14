import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { RouteDecision, RouteInput } from "#learn/agent/router";
import type { Viewer } from "#learn/retrieve/types";
import type { Bucket } from "@/lib/rate-limit";

import { conversations } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { liveRunIn } from "@/lib/agent-runs";
import { createLogger } from "@/lib/logger";
import {
  addMessageResponse,
  FOLLOW_UP_BUCKET,
  json,
  MessageSchema,
  readBody,
  type RunRoutesDeps,
  startRunResponse,
  takeOrRefuse,
} from "@/routes/api/runs/-runs";

const logger = createLogger("chat.router");

/** The router's own bucket: each message costs one small model call before anything else happens. It is the
 * follow-up bucket, so a message into a live run draws on it whichever route it takes. */
export const ROUTER_BUCKET: Bucket = FOLLOW_UP_BUCKET;

export const RouteRequestSchema = z.object({
  conversationId: z.uuid(),
  /** The run's id if this message starts one: the client's, so a retried request makes one run. */
  runId: z.uuid(),
  message: MessageSchema,
  /** The composer's "Run as agent": skip the router and go to the agent. */
  agent: z.boolean().optional(),
});

export interface RouterRouteDeps {
  runs: RunRoutesDeps;
  route: (input: RouteInput) => Promise<RouteDecision>;
  bucket?: Bucket;
  now?: () => Date;
}

/**
 * `POST /api/chat/router`: where a chat message goes (section 16.2). The router (or the composer's toggle) picks:
 * - `answer`: nothing happens here; the client sends the message to `POST /api/chat` for a cited answer.
 * - `agent`, with a live run in the conversation: the message goes into that run (`followUp: true`), through its
 *   message hook.
 * - `agent`, with none: a new run starts, in this conversation.
 */
export async function handleRouteMessage(request: Request, viewer: Viewer, deps: RouterRouteDeps): Promise<Response> {
  const body = await readBody(request, RouteRequestSchema);
  if (body instanceof Response) return body;
  const { db } = deps.runs;
  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(db, viewer.tenantId, fn);

  const [conversation] = await inTenant((tx) =>
    tx.select({ userId: conversations.userId }).from(conversations).where(eq(conversations.id, body.conversationId)),
  );
  if (conversation && conversation.userId !== viewer.userId) return json(404, { error: "not_found" });
  const live = conversation ? await inTenant((tx) => liveRunIn(tx, viewer, body.conversationId)) : null;

  // The router's bucket covers the routing call and every follow-up into a live run (which the run bucket, taken
  // only when a run starts, doesn't). Only the toggle starting a new run skips it.
  if (!body.agent || live) {
    const now = (deps.now ?? (() => new Date()))();
    const refused = await takeOrRefuse(db, viewer, deps.bucket ?? ROUTER_BUCKET, now);
    if (refused) return refused;
  }

  let decision: Pick<RouteDecision, "route" | "reason">;
  if (body.agent) {
    decision = { route: "agent", reason: "the user asked for the agent" };
  } else {
    const routed = await deps.route({ message: body.message.text, liveRun: live !== null });
    logger.info("routed", { route: routed.route, reason: routed.reason, liveRun: live !== null, usage: routed.usage });
    decision = routed;
  }

  if (decision.route === "answer") return json(200, { route: "answer", reason: decision.reason });

  if (live) {
    const response = await addMessageResponse(viewer, live.id, body.message, deps.runs);
    if (response.status !== 202) return response;
    return json(202, { route: "agent", reason: decision.reason, followUp: true, ...(await response.json()) });
  }

  // A run needs its conversation: make it, if this is the first message (a chat answer makes it the same way).
  await inTenant((tx) =>
    tx
      .insert(conversations)
      .values({
        id: body.conversationId,
        tenantId: viewer.tenantId,
        userId: viewer.userId,
        title: body.message.text.slice(0, 80),
      })
      .onConflictDoNothing(),
  );
  const [own] = await inTenant((tx) =>
    tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, body.conversationId), eq(conversations.userId, viewer.userId))),
  );
  if (!own) return json(404, { error: "not_found" });
  const response = await startRunResponse(
    viewer,
    { id: body.runId, conversationId: body.conversationId, message: body.message },
    deps.runs,
  );
  if (response.status !== 202) return response;
  return json(202, { route: "agent", reason: decision.reason, followUp: false, ...(await response.json()) });
}
