import { getWorkflowMetadata } from "workflow";

import { claimOutboxRow, ensureSubscription, syncDirectory, syncDrive } from "./sync-steps";

export interface SyncOptions {
  /** Keep a change-notification subscription pointing at the webhook route. Tests without the app turn it off. */
  subscribe?: boolean;
}

/**
 * Syncs one tenant: the directory first, so the ACLs that follow find their principals, then the drive (a full
 * crawl, or the changes since the last delta link), which queues an ingest per new or changed document, then the
 * subscription that brings the next change in by webhook.
 */
export async function syncWorkflow(
  tenantId: string,
  outboxId: string | null,
  mode: "full" | "delta",
  options: SyncOptions = {},
) {
  "use workflow";

  if (outboxId !== null) {
    const { workflowRunId } = getWorkflowMetadata();
    if (!(await claimOutboxRow(tenantId, outboxId, workflowRunId))) return { status: "duplicate" as const };
  }
  const directory = await syncDirectory(tenantId);
  const drive = await syncDrive(tenantId, mode);
  const subscription = options.subscribe === false ? null : await ensureSubscription(tenantId);
  return { status: "synced" as const, directory, drive, subscription };
}
