import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { deltaSync, fullSync } from "#learn/connectors/drive-sync";
import { GraphRequestError, ResyncRequiredError } from "#learn/connectors/graph";
import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import { claim, documentPartition, enqueue, kickRelay, syncPartition } from "@/db/outbox";
import { syncState } from "@/db/schema";
import { type Tx, withTenant } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

import { appUrl, asStep, CONNECTOR, graphFor, sha256Hex } from "./sync-common";

const logger = createLogger("workflows.sync");

const DRIVE = "drive";
/** Subscriptions last this long. Every sync renews it, which also finds one the service has forgotten. */
const SUBSCRIPTION_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first step of a run the relay started: it takes the outbox row for this run. The relay delivers at least
 * once, so a second run for the same row gets false and stops.
 */
export async function claimOutboxRow(tenantId: string, outboxId: string, runId: string): Promise<boolean> {
  "use step";
  return withTenant(tenantId, (tx) => claim(tx, outboxId, runId));
}
claimOutboxRow.maxRetries = 3;

/** One sync of a tenant at a time: a second waits for the first's transaction to end. */
async function lockTenantSync(tx: Tx, tenantId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${syncPartition(tenantId)}, 0))`);
}

async function driveState(tx: Tx) {
  const [state] = await tx
    .select()
    .from(syncState)
    .where(and(eq(syncState.connector, CONNECTOR), eq(syncState.scope, DRIVE)));
  return state;
}

/** Users, groups, direct memberships and the closure, for one tenant. */
export async function syncDirectory(tenantId: string) {
  "use step";
  return asStep(async () => {
    const snapshot = await fetchDirectory(await graphFor(tenantId));
    const result = await withTenant(tenantId, (tx) => applyDirectory(tx, tenantId, snapshot, new Date()));
    logger.info("directory synced", { tenantId, ...result });
    return result;
  });
}
syncDirectory.maxRetries = 5;

/**
 * The drive's changes since the last sync (or everything, for a full sync, a first sync, or an expired delta
 * link), written with their ACLs, and an outbox row per document to ingest, in one transaction. The relay
 * starts the ingest runs after it commits.
 */
export async function syncDrive(tenantId: string, mode: "full" | "delta") {
  "use step";
  const summary = await asStep(async () => {
    const graph = await graphFor(tenantId);
    return withTenant(tenantId, async (tx) => {
      await lockTenantSync(tx, tenantId);
      const state = await driveState(tx);
      let ran: "full" | "delta" = mode === "delta" && state?.deltaToken ? "delta" : "full";
      let report;
      if (ran === "delta") {
        try {
          report = await deltaSync(tx, tenantId, graph, state!.deltaToken!);
        } catch (error) {
          if (!(error instanceof ResyncRequiredError)) throw error;
          logger.warn("delta link expired: resyncing", { tenantId });
          ran = "full";
        }
      }
      report ??= await fullSync(tx, tenantId, graph);

      const now = new Date();
      await tx
        .insert(syncState)
        .values({
          tenantId,
          connector: CONNECTOR,
          scope: DRIVE,
          deltaToken: report.deltaLink,
          ...(ran === "full" ? { lastFullCrawlAt: now } : { lastDeltaAt: now }),
        })
        .onConflictDoUpdate({
          target: [syncState.tenantId, syncState.connector, syncState.scope],
          set: {
            deltaToken: report.deltaLink,
            updatedAt: now,
            ...(ran === "full" ? { lastFullCrawlAt: now } : { lastDeltaAt: now }),
          },
        });
      for (const { documentId, version } of report.ingest) {
        await enqueue(
          tx,
          tenantId,
          { kind: "ingest", payload: { documentId, version } },
          documentPartition(documentId),
        );
      }
      const { ingest, deltaLink: _, ...counts } = report;
      return { ran, ...counts, ingest: ingest.length };
    });
  });
  kickRelay();
  logger.info("drive synced", { tenantId, ...summary });
  return summary;
}
syncDrive.maxRetries = 5;

/**
 * Keeps a change-notification subscription for the drive, pointing at the webhook route. Each sync renews it; a
 * missing one (none yet, expired, or forgotten by a fake-workspace restart or reset, which the renewal's 404 shows)
 * is created with a fresh clientState, of which only a hash is kept. Creating one makes fake-workspace call the webhook for the validation handshake first.
 */
export async function ensureSubscription(tenantId: string) {
  "use step";
  return asStep(async () => {
    const graph = await graphFor(tenantId);
    const state = await withTenant(tenantId, driveState);
    const now = Date.now();
    const expiration = new Date(now + SUBSCRIPTION_DAYS * DAY_MS);
    if (state?.subscriptionId && state.subscriptionExpiresAt && state.subscriptionExpiresAt.getTime() > now) {
      try {
        await graph.renew(state.subscriptionId, expiration);
        await withTenant(tenantId, (tx) =>
          tx.update(syncState).set({ subscriptionExpiresAt: expiration }).where(eq(syncState.tenantId, tenantId)),
        );
        return { subscriptionId: state.subscriptionId, renewed: true };
      } catch (error) {
        // fake-workspace forgets subscriptions when it restarts: make a new one.
        if (!(error instanceof GraphRequestError && error.status === 404)) throw error;
      }
    }
    const clientState = randomBytes(32).toString("hex");
    const notificationUrl = `${appUrl()}/api/webhooks/workspace?tenant=${tenantId}`;
    const subscription = await graph.subscribe({ notificationUrl, clientState, expirationDateTime: expiration });
    await withTenant(tenantId, (tx) =>
      tx
        .insert(syncState)
        .values({
          tenantId,
          connector: CONNECTOR,
          scope: DRIVE,
          subscriptionId: subscription.id,
          clientStateHash: sha256Hex(clientState),
          subscriptionExpiresAt: expiration,
        })
        .onConflictDoUpdate({
          target: [syncState.tenantId, syncState.connector, syncState.scope],
          set: {
            subscriptionId: subscription.id,
            clientStateHash: sha256Hex(clientState),
            subscriptionExpiresAt: expiration,
            updatedAt: new Date(),
          },
        }),
    );
    logger.info("subscribed to drive changes", { tenantId, subscriptionId: subscription.id });
    return { subscriptionId: subscription.id, renewed: false };
  });
}
ensureSubscription.maxRetries = 3;
