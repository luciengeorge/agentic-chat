/**
 * The outbox and its relay (sections 05.3 and 05.5). Workflow's `start()` can't commit with our own writes, so a write that
 * asks for a run commits an outbox row beside it, in one transaction. The relay drains the rows and starts the runs;
 * it delivers at least once, so each run's first step claims its row by id, and a second run for the same row stops.
 * `src/db/outbox.ts` re-exports this module, so the app imports it from there.
 */
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { organization, outbox } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";

/** What the relay hands to a workflow start. Payloads carry ids, never content. */
export type OutboxMessage =
  | { kind: "sync"; payload: { mode: "full" | "delta" } }
  | { kind: "ingest"; payload: { documentId: string; version: number } };

export interface OutboxRow {
  id: string;
  tenantId: string;
  kind: string;
  payload: unknown;
  partitionKey: string;
  attempts: number;
}

const KICKS = Symbol.for("agentic-chat.relay-kicks");

/** Process-wide, like the pools: step code and the Vite graph load this module separately in dev. */
function kicks(): EventTarget {
  const store = globalThis as typeof globalThis & { [KICKS]?: EventTarget };
  return (store[KICKS] ??= new EventTarget());
}

/** Wakes the relay in this process now, instead of at its next poll. Call it after the outbox row commits. */
export function kickRelay(): void {
  kicks().dispatchEvent(new Event("kick"));
}

/** Calls `listener` on each kick; returns what stops it. */
export function onRelayKick(listener: () => void): () => void {
  kicks().addEventListener("kick", listener);
  return () => kicks().removeEventListener("kick", listener);
}

export const syncPartition = (tenantId: string) => `sync:${tenantId}`;
export const documentPartition = (documentId: string) => `document:${documentId}`;

/** Writes a row in the caller's transaction, so it commits with the writes it stands for. */
export async function enqueue(tx: Tx, tenantId: string, message: OutboxMessage, partitionKey: string) {
  const [row] = await tx
    .insert(outbox)
    .values({ tenantId, kind: message.kind, payload: message.payload, partitionKey })
    .returning({ id: outbox.id });
  return row.id;
}

/** A run claims its row as its first step. A row published this long ago and still unclaimed has no run left. */
const UNCLAIMED_SYNC_DEAD_AFTER = "10 minutes";

/**
 * Asks for a sync of the tenant unless one is already waiting to be picked up: an unclaimed sync reads the
 * changes when it runs, so a burst of notifications costs one sync. A row published long ago but never claimed
 * isn't waiting: its run died first. Runs are idempotent, so erring toward a second one is safe. Returns the new
 * row's id, or null.
 */
export async function enqueueSync(tx: Tx, tenantId: string, mode: "full" | "delta"): Promise<string | null> {
  const partitionKey = syncPartition(tenantId);
  const [waiting] = await tx
    .select({ id: outbox.id })
    .from(outbox)
    .where(
      and(
        eq(outbox.partitionKey, partitionKey),
        eq(outbox.kind, "sync"),
        isNull(outbox.claimedBy),
        isNull(outbox.failedAt),
        sql`${outbox.payload}->>'mode' = ${mode}`,
        or(isNull(outbox.publishedAt), sql`${outbox.publishedAt} > now() - ${UNCLAIMED_SYNC_DEAD_AFTER}::interval`),
      ),
    )
    .limit(1);
  if (waiting) return null;
  return enqueue(tx, tenantId, { kind: "sync", payload: { mode } }, partitionKey);
}

/**
 * `enqueueSync` for every tenant: the periodic sync. Listing tenants crosses them, so it reads on the owner's
 * pool; each request is written as the app role, in its tenant.
 */
export async function enqueueTenantSyncs(owner: Db, app: Db, mode: "full" | "delta") {
  const tenants = await owner.select({ id: organization.id }).from(organization);
  const queued: { tenantId: string; id: string | null }[] = [];
  for (const { id: tenantId } of tenants) {
    queued.push({ tenantId, id: await withTenantOn(app, tenantId, (tx) => enqueueSync(tx, tenantId, mode)) });
  }
  return queued;
}

/**
 * A workflow's first step: claims its row for the run. The relay delivers at least once, so a second run for
 * the same row gets false and stops. A retried step of the same run gets true again.
 */
export async function claim(tx: Tx, id: string, runId: string): Promise<boolean> {
  const rows = await tx
    .update(outbox)
    .set({ claimedBy: runId, claimedAt: new Date() })
    .where(and(eq(outbox.id, id), or(isNull(outbox.claimedBy), eq(outbox.claimedBy, runId))))
    .returning({ id: outbox.id });
  return rows.length === 1;
}

const RECORD_NAMESPACE = "6f6c1d2a-4b0e-4c55-9a51-2f9d8e0c7b13";

/** The id of the record a workflow-first run writes for `key` (say `ingest:<document>:<version>`): the same key
 * always gives the same id, so a second run for the same work finds the first one's record. */
export const recordIdFor = (key: string) => uuidv5(key, RECORD_NAMESPACE);

/**
 * The workflow-first shape: the run started first, and its first step writes the record, already published (no
 * relay delivers it) and claimed by this run. A second run for the same work (a retried start) finds the record
 * claimed by the first and gets false, as a duplicate delivery does with `claim`. A retried step of the same run
 * gets true again.
 */
export async function recordStart(
  tx: Tx,
  tenantId: string,
  message: OutboxMessage,
  partitionKey: string,
  id: string,
  runId: string,
): Promise<boolean> {
  await tx
    .insert(outbox)
    .values({
      id,
      tenantId,
      kind: message.kind,
      payload: message.payload,
      partitionKey,
      publishedAt: new Date(),
      claimedBy: runId,
      claimedAt: new Date(),
    })
    .onConflictDoNothing();
  return claim(tx, id, runId);
}

/** The delivery can't succeed for this row: it's marked failed at once. */
export class UndeliverableError extends Error {
  override name = "UndeliverableError";
}

/** The workflow world can't be reached: the batch rolls back and no attempt counts. */
export class OutageError extends Error {
  override name = "OutageError";
}

export type Deliver = (row: OutboxRow) => Promise<void>;

export interface RelayOptions {
  batchSize?: number;
  /** Attempts before a row is marked failed and skipped. */
  maxAttempts?: number;
}

export interface RelayResult {
  published: string[];
  /** Failed this time; tried again later. */
  retried: string[];
  failed: string[];
  /** Partitions another relay owns, or that wait on an older row. */
  skippedPartitions: string[];
  outage: boolean;
}

/**
 * One pass of the relay, on the owner's pool since it crosses tenants: `relayBatch` in one transaction. An outage
 * rolls the whole batch back, attempts uncounted, and comes back as `outage: true`.
 */
export async function relayOnce(db: Db, deliver: Deliver, options: RelayOptions = {}): Promise<RelayResult> {
  const { batchSize = 20, maxAttempts = 5 } = options;
  try {
    return await db.transaction((tx) => relayBatch(tx, deliver, batchSize, maxAttempts));
  } catch (error) {
    if (!(error instanceof OutageError)) throw error;
    return { published: [], retried: [], failed: [], skippedPartitions: [], outage: true };
  }
}

/**
 * Locks a batch of unpublished rows (`FOR UPDATE SKIP LOCKED`), takes each partition with `ownPartition` so one
 * relay owns a partition at a time, and delivers the partition's rows oldest first, stopping at the first failure
 * so they stay in order. A row is published once `deliver` returns; a failure counts an attempt, and the last
 * attempt (or an undeliverable row) marks it failed.
 */
export async function relayBatch(
  tx: Locked,
  deliver: Deliver,
  batchSize: number,
  maxAttempts: number,
): Promise<RelayResult> {
  const result: RelayResult = { published: [], retried: [], failed: [], skippedPartitions: [], outage: false };
  const rows = await tx
    .select({
      id: outbox.id,
      tenantId: outbox.tenantId,
      kind: outbox.kind,
      payload: outbox.payload,
      partitionKey: outbox.partitionKey,
      attempts: outbox.attempts,
      createdAt: outbox.createdAt,
    })
    .from(outbox)
    .where(and(isNull(outbox.publishedAt), isNull(outbox.failedAt)))
    .orderBy(asc(outbox.createdAt), asc(outbox.id))
    .limit(batchSize)
    .for("update", { skipLocked: true });

  const partitions = new Map<string, typeof rows>();
  for (const row of rows) partitions.set(row.partitionKey, [...(partitions.get(row.partitionKey) ?? []), row]);

  for (const [partitionKey, members] of partitions) {
    if (!(await ownPartition(tx, partitionKey, members[0]))) {
      result.skippedPartitions.push(partitionKey);
      continue;
    }
    for (const row of members) {
      const delivered = await deliverRow(tx, row, deliver, maxAttempts, result);
      if (!delivered) break;
    }
  }
  return result;
}

export type Locked = Tx;

/**
 * True when this relay may deliver the partition: it holds the partition's advisory lock until its transaction
 * ends, so a second relay skips the partition, and no older pending row of it is waiting outside this batch (one
 * another relay has locked, which this batch skipped past), since that row must go first.
 */
export async function ownPartition(
  tx: Locked,
  partitionKey: string,
  first: { id: string; createdAt: Date },
): Promise<boolean> {
  const [lock] = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${partitionKey}, 0)) AS locked`,
  );
  if (!lock.locked) return false;
  const older = await tx.execute(sql`
    SELECT 1 FROM ${outbox}
    WHERE ${outbox.partitionKey} = ${partitionKey} AND ${outbox.publishedAt} IS NULL AND ${outbox.failedAt} IS NULL
      AND (${outbox.createdAt}, ${outbox.id}) < (${first.createdAt.toISOString()}::timestamptz, ${first.id}::uuid)
    LIMIT 1`);
  return older.length === 0;
}

export async function deliverRow(
  tx: Locked,
  row: OutboxRow,
  deliver: Deliver,
  maxAttempts: number,
  result: RelayResult,
) {
  try {
    await deliver(row);
  } catch (error) {
    if (error instanceof OutageError) throw error;
    const attempts = row.attempts + 1;
    const failed = error instanceof UndeliverableError || attempts >= maxAttempts;
    await tx
      .update(outbox)
      .set({
        attempts,
        lastError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        failedAt: failed ? new Date() : null,
      })
      .where(eq(outbox.id, row.id));
    (failed ? result.failed : result.retried).push(row.id);
    return false;
  }
  await tx
    .update(outbox)
    .set({ publishedAt: new Date(), attempts: row.attempts + 1, lastError: null })
    .where(eq(outbox.id, row.id));
  result.published.push(row.id);
  return true;
}
