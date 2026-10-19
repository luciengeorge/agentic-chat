/**
 * The automation workflow's steps (section 16.4), and the drive-change trigger ingest calls when a document is
 * ready. A fire's runs act as the automation's owner, so their approvals land in the owner's inbox.
 */
import { eq } from "drizzle-orm";
import { start } from "workflow/api";

import type { Admission } from "#learn/agent/fanout";

import { changeFireKey, fireRun } from "#learn/automations/automation";
import { automations, documents } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { startRun } from "@/lib/agent-runs";
import { agentRuntime } from "@/lib/agent-runtime";
import { type Claim, claimFire, driveChangeAutomations, type FireItem } from "@/lib/automations";
import { createLogger } from "@/lib/logger";

import { automationWorkflow } from "./automation";

const logger = createLogger("workflows.automation");

/** Claims the fire, once. Everyone else who sees the same key gets `duplicate`. */
export async function claimFireStep(
  tenantId: string,
  automationId: string,
  fireKey: string,
  firedAt: string,
  documentIds: string[] | null,
): Promise<Claim> {
  "use step";
  return withTenantOn(agentRuntime().db, tenantId, (tx) =>
    claimFire(tx, automationId, fireKey, { firedAt: new Date(firedAt), documentIds }),
  );
}

/** Whether the owner may start another run now: not if the kill switch is on or their daily budget is spent. */
export async function admitStep(tenantId: string, ownerId: string): Promise<Admission> {
  "use step";
  const reason = await agentRuntime().admit?.({ tenantId, userId: ownerId });
  return reason ? { go: false, reason } : { go: true };
}

/**
 * Makes one run of the fire, `kind: automation`, as the owner, with the prompt (and its document's id) as the
 * first message. Its id comes from the fire and the item, so a step that runs again makes no second run.
 */
export async function createRunStep(
  tenantId: string,
  automationId: string,
  fireKey: string,
  ownerId: string,
  prompt: string,
  item: FireItem,
): Promise<string> {
  "use step";
  const { db } = agentRuntime();
  const { runId, message } = fireRun(automationId, fireKey, prompt, item);
  await startRun(db, { tenantId, userId: ownerId }, { runId, kind: "automation", automationId, message });
  await withTenantOn(db, tenantId, (tx) =>
    tx.update(automations).set({ lastRunId: runId }).where(eq(automations.id, automationId)),
  );
  return runId;
}

/**
 * The drive-change trigger: a document version became ready, so every enabled automation watching its folder
 * fires for it. The fire key is the version, so ingest running twice fires each automation once.
 */
export async function fireDriveChange(tenantId: string, documentId: string, version: number): Promise<number> {
  "use step";
  const { db } = agentRuntime();
  const [document] = await withTenantOn(db, tenantId, (tx) =>
    tx.select({ path: documents.path }).from(documents).where(eq(documents.id, documentId)),
  );
  if (!document) return 0;
  const ids = await driveChangeAutomations(db, tenantId, documentId, document.path);
  for (const automationId of ids) {
    await start(automationWorkflow, [
      tenantId,
      automationId,
      changeFireKey(documentId, version),
      new Date().toISOString(),
      [documentId],
    ]);
    logger.info("drive change fired", { automationId, documentId, version });
  }
  return ids.length;
}
fireDriveChange.maxRetries = 3;
