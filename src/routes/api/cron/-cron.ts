/**
 * The cron routes (section 22). In `pnpm dev`, server plugins keep the outbox relay, the scheduler, the periodic
 * sync and the agent queue's workers running. A serverless deploy has no process that stays up, so Vercel Cron
 * calls one route per job on a schedule (`vercel.json`), and each call does one bounded pass and returns.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Every other caller is refused, and with no secret set, every
 * caller is.
 */
import { asc, eq, max, sql } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";

import type { Db } from "@/db/create";
import type { Deliver } from "@/db/outbox";

import { enqueueSync, relayOnce } from "@/db/outbox";
import { organization, outbox } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

const logger = createLogger("cron");

export type CronResult = Record<string, unknown>;
export type CronPass = () => Promise<CronResult>;

const sha256 = (text: string) => createHash("sha256").update(text).digest();

/** True only for `Bearer <secret>`, compared in constant time. False whenever the secret is unset or blank. */
export function cronAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret?.trim()) return false;
  const header = request.headers.get("authorization") ?? "";
  return timingSafeEqual(sha256(header), sha256(`Bearer ${secret}`));
}

const notAllowed = () =>
  Response.json({ error: "cron routes answer GET only" }, { status: 405, headers: { allow: "GET" } });

/** Every method but GET, refused, so a cron path never falls through to the app's pages. */
export const OTHER_METHODS = { POST: notAllowed, PUT: notAllowed, PATCH: notAllowed, DELETE: notAllowed };

/** One cron call: refuse, or run the pass once and report what it did. */
export async function handleCron(
  request: Request,
  name: string,
  pass: CronPass,
  secret: string | undefined = process.env.CRON_SECRET,
): Promise<Response> {
  if (!secret?.trim()) {
    logger.error("cron refused: CRON_SECRET is not set", { job: name });
    return Response.json({ error: "CRON_SECRET is not set, so every caller is refused" }, { status: 503 });
  }
  if (!cronAuthorized(request, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  const started = Date.now();
  try {
    const result = await pass();
    const ms = Date.now() - started;
    logger.info("cron pass", { job: name, ms, ...result });
    return Response.json({ job: name, ms, ...result });
  } catch (error) {
    logger.error("cron pass failed", { job: name, error });
    return Response.json({ job: name, error: (error as Error).message }, { status: 500 });
  }
}

export const RELAY_BATCH = 20;
export const RELAY_MAX_BATCHES = 5;

/**
 * The relay's pass: `relayOnce` until a batch comes back short, an outage, or `maxBatches` batches (100 rows at
 * most). What's left waits for the next minute. Then `conversationLog`, when the log is on: a bounded drain of the
 * log rows a sink error left unclaimed, since no delivery will come for those again.
 */
export async function relayPass(
  system: Db,
  deliver: Deliver,
  {
    batchSize = RELAY_BATCH,
    maxBatches = RELAY_MAX_BATCHES,
    conversationLog,
  }: { batchSize?: number; maxBatches?: number; conversationLog?: (() => Promise<object>) | null } = {},
): Promise<CronResult> {
  let batches = 0;
  let published = 0;
  const retried: string[] = [];
  const failed: string[] = [];
  let outage = false;
  while (batches < maxBatches) {
    batches += 1;
    const result = await relayOnce(system, deliver, { batchSize });
    published += result.published.length;
    retried.push(...result.retried);
    failed.push(...result.failed);
    outage = result.outage;
    if (outage || result.published.length < batchSize) break;
  }
  const log = conversationLog ? await conversationLog() : "off";
  return { batches, published, retried, failed, outage, conversationLog: log };
}

export const SYNC_MAX_TENANTS = 50;

/**
 * The tenants a sync pass takes, at most `limit`: round robin by when each last had a sync asked for (the newest
 * sync row in the outbox), never-synced first. The outbox is the cursor, so nothing else is stored, and a tenant a
 * full pass left out goes first next time. It reads across tenants, so on the owner's pool.
 */
export async function tenantsDueForSync(system: Db, limit: number): Promise<string[]> {
  const last = system
    .select({ tenantId: outbox.tenantId, at: max(outbox.createdAt).as("last_sync_at") })
    .from(outbox)
    .where(eq(outbox.kind, "sync"))
    .groupBy(outbox.tenantId)
    .as("last_sync");
  const rows = await system
    .select({ id: organization.id })
    .from(organization)
    .leftJoin(last, eq(last.tenantId, organization.id))
    .orderBy(sql`${last.at} ASC NULLS FIRST`, asc(organization.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

/**
 * The periodic sync: a delta sync request for at most `maxTenants` tenants, through the outbox (the relay's pass
 * starts them). Every five minutes, so 50 a pass covers 600 tenants an hour; the rest wait their turn.
 */
export async function syncPass(
  system: Db,
  app: Db,
  workspaceConfigured: boolean,
  { maxTenants = SYNC_MAX_TENANTS } = {},
): Promise<CronResult> {
  if (!workspaceConfigured) return { skipped: "no workspace is configured (FAKE_WORKSPACE_URL)" };
  const tenants = await tenantsDueForSync(system, maxTenants);
  let queued = 0;
  for (const tenantId of tenants) {
    if (await withTenantOn(app, tenantId, (tx) => enqueueSync(tx, tenantId, "delta"))) queued += 1;
  }
  return { tenants: tenants.length, queued };
}

/** The scheduler's tick: the schedule slots due now, then runs whose workflow was cancelled outside the app. */
export async function schedulerPass(
  enabled: boolean,
  tick: () => Promise<unknown[]>,
  reconcile: () => Promise<string[]>,
): Promise<CronResult> {
  if (!enabled) return { skipped: "AGENT_RUNNER isn't workflow" };
  const fired = await tick();
  const reconciled = await reconcile();
  return { fired: fired.length, reconciled };
}

export const QUEUE_MAX_JOBS = 5;
/** No new job is claimed after this; one already claimed runs to its end (an agent step allows 120 s). */
export const QUEUE_BUDGET_MS = 45_000;

/** The job queue's pass: works due jobs one at a time, up to `maxJobs` or the time budget, until none is due. */
export async function queuePass(
  enabled: boolean,
  workOnce: () => Promise<boolean>,
  { maxJobs = QUEUE_MAX_JOBS, budgetMs = QUEUE_BUDGET_MS, now = Date.now } = {},
): Promise<CronResult> {
  if (!enabled) return { skipped: "AGENT_RUNNER isn't queue" };
  const deadline = now() + budgetMs;
  let worked = 0;
  while (worked < maxJobs && now() < deadline && (await workOnce())) worked += 1;
  return { worked };
}
