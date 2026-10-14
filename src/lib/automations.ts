/**
 * Automations in the app (section 16.4): the table's reads and writes, claiming a fire once, and what a scheduler
 * tick finds due. Server only. The rules (cron, folders, fire keys) are `#learn/automations/*`.
 */
import { and, desc, eq, sql } from "drizzle-orm";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import {
  type DocumentRef,
  dueSlot,
  inFolder,
  type NewAutomation,
  scheduleFireKey,
  type Trigger,
} from "#learn/automations/automation";
import { canRead, readable } from "#learn/retrieve/acl";
import { automationFires, automations, runs } from "@/db/schema";
import { type Tx, withTenantOn } from "@/db/tenant";
import { createLogger } from "@/lib/logger";

const logger = createLogger("automations");

export interface AutomationRow {
  id: string;
  ownerId: string;
  name: string;
  prompt: string;
  trigger: Trigger;
  enabled: boolean;
  lastFiredAt: string | null;
  lastRun: { id: string; status: string; createdAt: string } | null;
  createdAt: string;
}

type Row = typeof automations.$inferSelect;

const triggerOf = (row: Row): Trigger =>
  row.trigger === "schedule"
    ? { kind: "schedule", cron: row.cron!, folder: row.folder }
    : { kind: "drive_change", folder: row.folder! };

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());

/** The viewer's automations, newest first, each with its latest run. */
export async function listAutomations(tx: Tx, viewer: Viewer): Promise<AutomationRow[]> {
  const rows = await tx
    .select()
    .from(automations)
    .where(eq(automations.ownerId, viewer.userId))
    .orderBy(desc(automations.createdAt));
  const latest = await tx.execute<{ automation_id: string; id: string; status: string; created_at: Date | string }>(sql`
    SELECT DISTINCT ON (automation_id) automation_id, id, status, created_at FROM runs
    WHERE user_id = ${viewer.userId} AND automation_id IS NOT NULL
    ORDER BY automation_id, created_at DESC`);
  const byAutomation = new Map(latest.map((r) => [r.automation_id, r]));
  return rows.map((row) => {
    const run = byAutomation.get(row.id);
    return {
      id: row.id,
      ownerId: row.ownerId,
      name: row.name,
      prompt: row.prompt,
      trigger: triggerOf(row),
      enabled: row.enabled,
      lastFiredAt: iso(row.lastFiredAt),
      lastRun: run ? { id: run.id, status: run.status, createdAt: iso(run.created_at)! } : null,
      createdAt: iso(row.createdAt)!,
    };
  });
}

export async function createAutomation(tx: Tx, viewer: Viewer, input: NewAutomation): Promise<string> {
  const [row] = await tx
    .insert(automations)
    .values({
      tenantId: viewer.tenantId,
      ownerId: viewer.userId,
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger.kind,
      cron: input.trigger.kind === "schedule" ? input.trigger.cron : null,
      folder: input.trigger.folder,
    })
    .returning({ id: automations.id });
  return row.id;
}

/** Turns the viewer's automation on or off. False when it isn't theirs. */
export async function setAutomationEnabled(tx: Tx, viewer: Viewer, id: string, enabled: boolean): Promise<boolean> {
  const rows = await tx
    .update(automations)
    .set({ enabled })
    .where(and(eq(automations.id, id), eq(automations.ownerId, viewer.userId)))
    .returning({ id: automations.id });
  return rows.length > 0;
}

/** The runs an automation started, newest first. */
export async function automationRuns(tx: Tx, viewer: Viewer, automationId: string, limit = 10) {
  return tx
    .select({ id: runs.id, status: runs.status, createdAt: runs.createdAt })
    .from(runs)
    .where(and(eq(runs.automationId, automationId), eq(runs.userId, viewer.userId)))
    .orderBy(desc(runs.createdAt))
    .limit(limit);
}

/** One item of a fire: a run, about a document or not. */
export type FireItem = { document: DocumentRef | null };

export type Claim =
  | { kind: "duplicate" | "disabled" }
  | { kind: "fire"; ownerId: string; prompt: string; items: FireItem[] };

/** Documents per fire, at most: a folder full of new files makes a digest of the first ones, not a flood. */
export const MAX_FIRE_ITEMS = 25;

/**
 * Claims a fire for the automation, once: the first caller with this key inserts the row and gets the work; any
 * other (a second scheduler, a retried step, ingest seeing the same version twice) gets `duplicate`. A disabled or
 * deleted automation doesn't fire.
 *
 * The items: the documents given (a drive change); for a schedule over a folder, the documents in it that became
 * ready since the fire before; otherwise one run with no document. Only documents the owner can read count.
 */
export async function claimFire(
  tx: Tx,
  automationId: string,
  fireKey: string,
  { firedAt, documentIds }: { firedAt: Date; documentIds: string[] | null },
): Promise<Claim> {
  const [automation] = await tx.select().from(automations).where(eq(automations.id, automationId)).for("update");
  if (!automation?.enabled) return { kind: "disabled" };
  const claimed = await tx
    .insert(automationFires)
    .values({ tenantId: automation.tenantId, automationId, fireKey })
    .onConflictDoNothing()
    .returning({ key: automationFires.fireKey });
  if (claimed.length === 0) return { kind: "duplicate" };

  const since = automation.lastFiredAt ?? automation.createdAt;
  await tx
    .update(automations)
    .set({ lastFiredAt: sql`GREATEST(${automations.lastFiredAt}, ${firedAt.toISOString()}::timestamptz)` })
    .where(eq(automations.id, automationId));

  let documents: DocumentRef[] = [];
  const owner = automation.ownerId;
  if (documentIds?.length) {
    documents = await readyDocuments(
      tx,
      owner,
      sql`doc.id IN (${sql.join(
        documentIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
  } else if (automation.folder) {
    documents = await readyDocuments(tx, owner, sql`doc.updated_at > ${new Date(since).toISOString()}::timestamptz`);
  }
  const folder = automation.folder;
  const inScope = folder ? documents.filter((d) => inFolder(folder, d.path)) : documents;
  const items: FireItem[] =
    documentIds || automation.folder
      ? inScope.slice(0, MAX_FIRE_ITEMS).map((document) => ({ document }))
      : [{ document: null }];
  return { kind: "fire", ownerId: automation.ownerId, prompt: automation.prompt, items };
}

/** Ready documents the owner can read: a run acts as the owner, so it never hears of one they can't. */
async function readyDocuments(tx: Tx, ownerId: string, where: ReturnType<typeof sql>): Promise<DocumentRef[]> {
  return tx.execute<DocumentRef & Record<string, unknown>>(sql`
    SELECT doc.id, doc.title, doc.path FROM documents doc
    WHERE doc.status = 'ready' AND doc.deleted_at IS NULL AND ${where} AND ${readable(ownerId, sql`doc.id`)}
    ORDER BY doc.path`);
}

/** A fire to start: which automation, its key, and when it fired. */
export interface DueFire {
  tenantId: string;
  automationId: string;
  fireKey: string;
  firedAt: Date;
}

/**
 * The schedule fires due now, across every tenant (the owner's pool, as the relay reads the outbox): each enabled
 * schedule's latest slot that hasn't been claimed. Starting one twice is harmless, since only one claim wins.
 */
export async function dueScheduleFires(system: Db, now: Date): Promise<DueFire[]> {
  const rows = await system.execute<{
    id: string;
    tenant_id: string;
    cron: string;
    created_at: Date | string;
    last_fired_at: Date | string | null;
  }>(sql`
    SELECT id, tenant_id, cron, created_at, last_fired_at FROM automations
    WHERE enabled AND trigger = 'schedule'`);
  const due: DueFire[] = [];
  for (const row of rows) {
    let slot: Date | null;
    try {
      slot = dueSlot(row.cron, {
        now,
        createdAt: new Date(row.created_at),
        lastFiredAt: row.last_fired_at === null ? null : new Date(row.last_fired_at),
      });
    } catch (error) {
      logger.warn("an automation's schedule can't be read; skipped", { automationId: row.id, error });
      continue;
    }
    if (slot)
      due.push({ tenantId: row.tenant_id, automationId: row.id, fireKey: scheduleFireKey(slot), firedAt: slot });
  }
  return due;
}

/** The tenant's enabled drive-change automations whose folder holds the document and whose owner can read it. */
export async function driveChangeAutomations(
  db: Db,
  tenantId: string,
  documentId: string,
  documentPath: string,
): Promise<string[]> {
  return withTenantOn(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: automations.id, folder: automations.folder, ownerId: automations.ownerId })
      .from(automations)
      .where(and(eq(automations.trigger, "drive_change"), eq(automations.enabled, true)));
    const ids: string[] = [];
    for (const row of rows) {
      if (row.folder && inFolder(row.folder, documentPath) && (await canRead(tx, row.ownerId, documentId))) {
        ids.push(row.id);
      }
    }
    return ids;
  });
}
