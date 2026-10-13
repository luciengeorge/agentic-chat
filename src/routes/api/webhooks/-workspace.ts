import { and, eq } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import type { Db } from "@/db/create";

import { enqueueSync } from "@/db/outbox";
import { syncState } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

const logger = createLogger("webhooks.workspace");

/** Graph's tokens are about 100 characters; anything much longer isn't one. */
const MAX_VALIDATION_TOKEN = 1024;
const MAX_BODY_BYTES = 256 * 1024;

const NotificationsSchema = z.object({
  value: z
    .array(z.object({ subscriptionId: z.string().max(200), clientState: z.string().max(256) }).loose())
    .min(1)
    .max(100),
});

const TenantSchema = z.uuid();

const sha256 = (text: string) => createHash("sha256").update(text).digest();

function sameHash(clientState: string, storedHex: string | null): boolean {
  if (!storedHex) return false;
  const stored = Buffer.from(storedHex, "hex");
  const sent = sha256(clientState);
  return stored.length === sent.length && timingSafeEqual(stored, sent);
}

/**
 * `POST /api/webhooks/workspace?tenant=<id>`. With `validationToken`, the subscription handshake: the token
 * back as text/plain. Otherwise change notifications, which carry no change, only "look again": each one whose
 * subscription and clientState match the tenant's asks for a delta sync through the outbox, and the relay starts
 * it. A notification that matches nothing is refused (403), so a forged one queues nothing.
 */
export async function handleWorkspaceWebhook(
  request: Request,
  { db, kick }: { db: Db; kick: () => void },
): Promise<Response> {
  const url = new URL(request.url);
  const validationToken = url.searchParams.get("validationToken");
  if (validationToken !== null) {
    if (validationToken.length > MAX_VALIDATION_TOKEN) return new Response("token too long", { status: 400 });
    return new Response(validationToken, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const tenant = TenantSchema.safeParse(url.searchParams.get("tenant"));
  if (!tenant.success) return Response.json({ error: "tenant must be a uuid" }, { status: 400 });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return Response.json({ error: "too large" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "too large" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "not JSON" }, { status: 400 });
  }
  const body = NotificationsSchema.safeParse(json);
  if (!body.success) return Response.json({ error: "not a change notification" }, { status: 400 });

  const tenantId = tenant.data;
  const outcome = await withTenantOn(db, tenantId, async (tx) => {
    const [state] = await tx
      .select({ subscriptionId: syncState.subscriptionId, clientStateHash: syncState.clientStateHash })
      .from(syncState)
      .where(and(eq(syncState.connector, "workspace"), eq(syncState.scope, "drive")));
    const matching = body.data.value.filter(
      (n) => state?.subscriptionId === n.subscriptionId && sameHash(n.clientState, state.clientStateHash),
    );
    if (matching.length === 0) return { accepted: false, queued: null };
    return { accepted: true, queued: await enqueueSync(tx, tenantId, "delta") };
  });

  if (!outcome.accepted) {
    logger.warn("notification refused: no matching subscription or clientState", { tenantId });
    return Response.json({ error: "unknown subscription" }, { status: 403 });
  }
  if (outcome.queued) kick();
  logger.info("notification accepted", { tenantId, queued: outcome.queued });
  return new Response(null, { status: 202 });
}
