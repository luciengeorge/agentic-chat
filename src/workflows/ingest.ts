import { defineHook, getWorkflowMetadata } from "workflow";
import { start } from "workflow/api";

import { fanOut, pageRanges, type RangeResult } from "#learn/queue/fanout";

import { fireDriveChange } from "./automation-steps";
import {
  driveChangeFailed,
  embedChunks,
  failIngest,
  finishIngest,
  parseAndChunk,
  recordIngestStart,
  startIngest,
  storeBlob,
} from "./ingest-steps";
import { claimOutboxRow } from "./sync-steps";

export interface IngestOptions {
  /** A PDF with more pages than this fans out to child runs, one per page range. */
  fanOutPages?: number;
  rangePages?: number;
  /** Started directly, with no outbox row (`INGEST_START=workflow-first`): the first step writes the record. */
  workflowFirst?: boolean;
}

const FAN_OUT_PAGES = 500;
const RANGE_PAGES = 250;
/** Child runs started at once. */
const BATCH = 10;

const rangeDone = defineHook<RangeResult>();

/**
 * Ingests one version of a document: claim the outbox row, store the bytes, parse, chunk, write the chunks, embed
 * them, mark it ready, and fire the drive-change automations watching its folder. A long PDF fans out to one child
 * run per page range, each resuming this run's hook when it's done. A failure before the document is ready marks it
 * failed; a failure to fire its automations is only logged.
 */
export async function ingestWorkflow(
  tenantId: string,
  documentId: string,
  version: number,
  outboxId: string | null,
  options: IngestOptions = {},
) {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  if (outboxId !== null && !(await claimOutboxRow(tenantId, outboxId, workflowRunId))) {
    return { status: "duplicate" as const, chunks: 0 };
  }
  if (outboxId === null && options.workflowFirst) {
    if (!(await recordIngestStart(tenantId, documentId, version, workflowRunId))) {
      return { status: "duplicate" as const, chunks: 0 };
    }
  }
  const started = await startIngest(tenantId, documentId, version);
  if (started.skip) return { status: started.skip, chunks: 0 };

  let finished: Awaited<ReturnType<typeof finishIngest>>;
  try {
    const stored = await storeBlob(tenantId, documentId, version);
    if (stored.skip) return { status: stored.skip, chunks: 0 };

    const fanOutPages = options.fanOutPages ?? FAN_OUT_PAGES;
    if (stored.pages !== null && stored.pages > fanOutPages) {
      const ranges = pageRanges(stored.pages, options.rangePages ?? RANGE_PAGES);
      await fanOut(ranges, BATCH, async (range, index) => {
        const token = `ingest-range:${workflowRunId}:${index}`;
        const hook = rangeDone.create({ token });
        await start(ingestRangeWorkflow, [tenantId, documentId, version, range.from, range.to, index, token]);
        return hook;
      });
    } else {
      await parseAndChunk(tenantId, documentId, version, null, 0);
    }
    await embedChunks(tenantId, documentId, version);
    finished = await finishIngest(tenantId, documentId, version);
  } catch (error) {
    await failIngest(tenantId, documentId, version, error instanceof Error ? error.message : String(error));
    throw error;
  }
  // Outside the try: the document is ready whatever happens to the automations watching it.
  if (finished.status === "ready") {
    try {
      await fireDriveChange(tenantId, documentId, version);
    } catch (error) {
      await driveChangeFailed(tenantId, documentId, version, error instanceof Error ? error.message : String(error));
    }
  }
  return finished;
}

/** A child run: one page range of a long PDF. It always resumes its parent, with its chunk count or its error. */
export async function ingestRangeWorkflow(
  tenantId: string,
  documentId: string,
  version: number,
  from: number,
  to: number,
  index: number,
  token: string,
) {
  "use workflow";

  let result: RangeResult;
  try {
    const { chunks } = await parseAndChunk(tenantId, documentId, version, { from, to }, index);
    result = { status: "completed", chunks };
  } catch (error) {
    result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  await resumeParent(token, result);
  return result;
}

async function resumeParent(token: string, result: RangeResult) {
  "use step";
  await rangeDone.resume(token, result);
}
resumeParent.maxRetries = 5;
