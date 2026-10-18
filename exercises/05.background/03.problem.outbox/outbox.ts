// 👨‍💼 When a sync writes a document's new version, an ingest run has to start for it: always, and only if the
//    version really committed. Workflow's start() is a call to another system, so it can't join the database
//    transaction. Kestrel needs a way to make "save the version" and "ingest it" happen together.

/**
 * The outbox and its relay (section 05.3). Workflow's `start()` can't commit with our own writes, so a write that
 * asks for a run commits an outbox row beside it, in one transaction. The relay drains the rows and starts the runs;
 * it delivers at least once, so each run's first step claims its row by id, and a second run for the same row stops.
 * `src/db/outbox.ts` re-exports this module, so the app imports it from there.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
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
 * One pass of the relay, on the owner's pool since it crosses tenants. It locks a batch of unpublished rows
 * (`FOR UPDATE SKIP LOCKED`), takes each partition with a transaction-scoped advisory lock so one relay owns a
 * partition at a time, and delivers the partition's rows oldest first, stopping at the first failure so they
 * stay in order. A row is published once `deliver` returns; a failure counts an attempt, and the last attempt
 * (or an undeliverable row) marks it failed. An outage rolls the whole batch back, attempts uncounted.
 */
export async function relayOnce(db: Db, deliver: Deliver, options: RelayOptions = {}): Promise<RelayResult> {
  const { batchSize = 20, maxAttempts = 5 } = options;
  const result: RelayResult = { published: [], retried: [], failed: [], skippedPartitions: [], outage: false };
  // 🐨 In one transaction on `db`, lock a batch: the oldest `batchSize` rows that are neither published nor failed
  //    (by `createdAt`, then `id`), passing over rows another relay has locked. Select the fields an OutboxRow has,
  //    plus `createdAt`, which ownPartition needs.
  // 🐨 Group the rows by `partitionKey`, keeping them oldest first within each partition.
  // 🐨 For each partition: when ownPartition(tx, key, its first row) says no, add the key to
  //    `result.skippedPartitions` and leave the partition alone. Otherwise deliver its rows in order with
  //    deliverRow, and stop at the first one that didn't go out: the rows behind it wait for the next pass.
  // 🐨 An OutageError from `deliver` means the world is down. Let it escape the transaction, so the whole batch
  //    rolls back (attempts included); catch it outside, and return a result with `outage: true` and empty lists.
  //    Rethrow any other error.
  //
  // 💰 `tx.select({ id: outbox.id, ... }).from(outbox).where(and(isNull(outbox.publishedAt), ...))
  //    .orderBy(asc(outbox.createdAt), asc(outbox.id)).limit(n).for("update", { skipLocked: true })`. Import `asc`
  //    from "drizzle-orm" next to `and`. A `Map` keeps keys in the order you first set them.
  //
  // 🦉 Why an outbox at all. start() can't commit with our writes. Write the version, then call start(), and a crash
  //    between the two leaves a version nobody ingests: the next sync sees nothing new, so it never asks again.
  //    Call start() first, and the run may start for a write that then rolls back. The outbox row commits in the
  //    same transaction as the version, so it exists exactly when the version does; the relay starts runs only for
  //    committed rows.
  // 🦉 Why at least once, and why that's safe. deliverRow marks a row published after `deliver` returns. Crash in
  //    between and the next pass delivers it again: a second run for the same row. So every run's first step
  //    claims its row by id (`claim`, below): the second run finds it claimed by the first, and stops as a
  //    duplicate. The relay never has to be exactly-once; the run is idempotent.
  // 🦉 Why partitions, and stopping at the first failure. A partition is one document (`document:<id>`) or one
  //    tenant's syncs (`sync:<tenant>`). Its rows must start in the order they were written. Deliver version 2's
  //    ingest while version 1's failed start waits for a retry, and version 1 runs last. So a failure holds back
  //    the rows behind it, in its partition only.
  // 🦉 Why ownPartition. Two relays (the kicked one and the two-second safety net, or two servers) lock different
  //    rows with SKIP LOCKED and could each deliver part of one partition. ownPartition takes the partition's
  //    advisory lock for this transaction, and also says no while an older row of it is locked elsewhere.
  // 🦉 Why roll back on an outage. When the world is unreachable, every start fails. Counting those as attempts
  //    would use up every row's five in a few seconds and mark good rows failed. The rollback leaves them exactly
  //    as they were.
  // 🦉 New in this file, already written: `claim` and `recordStart` (the run's side, and workflow-first),
  //    `ownPartition` and `deliverRow` (which counts the attempt, and marks the row published, retried or failed).
  //
  // 📜 https://microservices.io/patterns/data/transactional-outbox.html
  // 📜 https://workflow-sdk.dev/docs/foundations/idempotency
  //
  // 🚨 The tests check that every tenant's rows go out oldest first and are marked published, that a failure holds
  //    back its own partition and not the others, that a row fails after its last attempt and an undeliverable one
  //    at once, that an outage rolls the batch back with no attempts counted, that a second relay leaves a
  //    partition the first holds alone, and, in real runs, that a full sync's 40 rows go out 20 at a time and a
  //    row delivered twice starts one ingest and one duplicate.
  throw new Error(
    `relayOnce(${typeof db}, ${typeof deliver}, batch ${batchSize}, ${maxAttempts} attempts, ${result.outage}) isn't written yet`,
  );
}

export type Locked = Tx;

/**
 * The partition's advisory lock, and no older pending row outside the batch: that one is locked by another
 * relay (which skipped us) or beyond the batch, and must go first.
 */
export async function ownPartition(tx: Locked, partitionKey: string, first: { id: string; createdAt: Date }) {
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
