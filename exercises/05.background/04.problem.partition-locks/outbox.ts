// 👨‍💼 The dev server runs the relay twice over: once on every kick, once every two seconds, and in production on
//    every server. Two relays must never start one document's versions out of order, and a workflow outage must
//    not use up every row's five attempts in ten seconds.

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
  // 🐨 Run relayBatch(tx, deliver, batchSize, maxAttempts) in one transaction on `db`, and return its result.
  // 🐨 An OutageError from `deliver` means the workflow world is down. Let it escape the transaction, so the whole
  //    batch rolls back; catch it outside, and return a result with `outage: true` and every list empty (nothing
  //    was published, since the batch rolled back). Rethrow any other error: only an OutageError is an outage.
  //
  // 💰 `db.transaction(async (tx) => ...)` resolves to what the callback returns, commits when it returns, and
  //    rolls back when it throws. `error instanceof OutageError`.
  //
  // 🦉 Why an outage is special. While the world is down, every start fails. Counted as ordinary failures, each
  //    pass would cost every row it reaches an attempt: five passes, ten seconds of polling, and those good rows
  //    are failed for good. So deliverRow lets an OutageError through without counting it, and stops the pass.
  // 🦉 Why roll back. The rule stays simple: a pass happens whole or not at all, and during an outage the outbox
  //    doesn't change. The starts that went out before the outage are delivered again next pass, and their second
  //    runs find the row claimed and stop as duplicates (step 3's at least once). Catch the error inside the
  //    callback and the transaction commits half a pass instead.
  throw new Error(
    `relayOnce(${typeof db}, ${typeof deliver}, batch ${batchSize}, ${maxAttempts} attempts) isn't written yet`,
  );
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
  // 🐨 Take the partition's advisory lock for the rest of this transaction, without waiting for it. When another
  //    relay holds it, return false: that relay is delivering this partition.
  // 🐨 Then look for an older pending row of the partition: neither published nor failed, and before `first` (by
  //    `createdAt`, then `id`, the batch's order). If there is one, return false: it must go first. Otherwise true.
  // 🐨 The classic mistakes are in the lock. One that waits (`pg_advisory_xact_lock`) makes the second relay sit
  //    until the first finishes its whole batch, which is what SKIP LOCKED was for. One that isn't `_xact`
  //    (`pg_try_advisory_lock`) belongs to the connection, which the pool hands to the next query: it outlives the
  //    transaction and holds the partition for ever.
  //
  // 💰 `tx.execute<{ locked: boolean }>(sql`SELECT ... AS locked`)` gives back rows. `pg_try_advisory_xact_lock(n)`
  //    answers true or false at once, and a true holds the lock until the transaction ends; `hashtextextended(key,
  //    0)` turns a string into the number `n`. Inside `sql`, `${outbox}` and `${outbox.createdAt}` name the table
  //    and its columns. Postgres compares rows left to right: `(a, b) < (x, y)`. A Date goes in as
  //    `${date.toISOString()}::timestamptz`, an id as `${id}::uuid`.
  //
  // 🦉 Why step 3's relay isn't enough. Relay 1 locks version 1's row and starts it. Relay 2's SKIP LOCKED passes
  //    over that row, takes version 2's, and starts it at the same moment, or first. Row locks keep two relays off
  //    one row; they say nothing about the rows beside it. The partition needs a lock of its own.
  // 🦉 Why an advisory lock. It's a lock on a number you choose, not on a row, so it can stand for a whole
  //    partition, rows that don't exist yet included. The `_xact` kind ends with the transaction, like the row
  //    locks, so a crashed relay can't keep it.
  // 🦉 Why both checks. The lock alone misses a row another relay has locked but not reached yet (its batch had
  //    another partition first): that relay doesn't hold the partition's lock yet, and this one would start
  //    version 2 before version 1. The older row catches it. The older row alone misses a late commit: `createdAt`
  //    is when the writing transaction began, so a slow one commits a row older than rows already going out, while
  //    relay 1 is still delivering the partition. The lock catches that.
  // 🦉 New in this file, already written: relayBatch now asks ownPartition before it delivers a partition, and
  //    lists the ones it was refused in `result.skippedPartitions`.
  //
  // 📜 https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS
  // 📜 https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
  //
  // 🚨 The tests check that a second relay skips a partition whose older row the first has locked, and one the
  //    first is delivering, even for a row that committed late, without waiting and while other partitions go out;
  //    that no advisory lock outlives a pass; that an outage rolls the batch back with no attempts counted and
  //    reports it; that any other error still throws; and, in real rows, that an outage at the 8th of a full sync's
  //    40 starts leaves all 40 waiting at 0 attempts.
  throw new Error(
    `ownPartition(${typeof tx}, ${partitionKey}, row ${first.id} of ${first.createdAt.toISOString()}) isn't written yet`,
  );
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
