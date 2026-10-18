/**
 * Two ways to start an ingest run once a sync has written a document's new version (section 05.3).
 *
 * - **Outbox (the default).** The sync writes an outbox row in the same transaction as the version, and the relay
 *   starts the run after it commits. The new version and the request to ingest it commit together, so no version
 *   is ever left without a run. Use it when the start must commit with other data, as a sync's documents and its
 *   ingest requests must, or a webhook receipt and its dedupe key.
 * - **Workflow-first** (`INGEST_START=workflow-first`). The sync workflow starts each ingest run itself, in a step
 *   after the drive step, and the run's first step writes its own record (`recordIngestStart`). Nothing in our
 *   database is written before the start, so it suits work the workflow owns from the start. Here it is safe only
 *   because the list of runs to start is a step's recorded output: if the start step dies halfway, Workflow retries
 *   it with the same list, and a run started twice finds its record taken and stops. Start the runs from the drive
 *   step instead, after its commit, and a crash between the commit and the starts leaves versions nobody ingests:
 *   the next sync sees no new content, so it queues nothing.
 */
import { start } from "workflow/api";

import { createLogger } from "@/lib/logger";

import { ingestWorkflow } from "./ingest";

const logger = createLogger("workflows.ingest-start");

/** Starts one ingest run per new version, each writing its own record first. Safe to run twice. */
export async function startIngestRuns(tenantId: string, requests: Array<{ documentId: string; version: number }>) {
  "use step";
  for (const { documentId, version } of requests) {
    await start(ingestWorkflow, [tenantId, documentId, version, null, { workflowFirst: true }]);
  }
  logger.info("ingest runs started, workflow-first", { tenantId, runs: requests.length });
  return requests.length;
}
startIngestRuns.maxRetries = 5;
