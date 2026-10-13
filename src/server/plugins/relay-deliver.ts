import { start } from "workflow/api";

import { type OutboxRow, OutageError, UndeliverableError } from "@/db/outbox";
import { ingestWorkflow } from "@/workflows/ingest";
import { syncWorkflow } from "@/workflows/sync";

const SyncPayload = (payload: unknown) =>
  typeof payload === "object" && payload !== null && ["full", "delta"].includes((payload as { mode?: string }).mode!)
    ? (payload as { mode: "full" | "delta" })
    : null;

const IngestPayload = (payload: unknown) => {
  const { documentId, version } = (payload ?? {}) as { documentId?: unknown; version?: unknown };
  return typeof documentId === "string" && Number.isInteger(version)
    ? { documentId, version: version as number }
    : null;
};

/** No answer at all from the world: the relay rolls its batch back and tries again, attempts uncounted. */
function isOutage(error: unknown): boolean {
  const code =
    (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT";
}

/** Starts the workflow an outbox row asks for. The run's first step claims the row, so a second start is harmless. */
export async function deliver(row: OutboxRow): Promise<void> {
  try {
    if (row.kind === "sync") {
      const payload = SyncPayload(row.payload);
      if (!payload) throw new UndeliverableError(`bad sync payload ${JSON.stringify(row.payload)}`);
      await start(syncWorkflow, [row.tenantId, row.id, payload.mode]);
    } else if (row.kind === "ingest") {
      const payload = IngestPayload(row.payload);
      if (!payload) throw new UndeliverableError(`bad ingest payload ${JSON.stringify(row.payload)}`);
      await start(ingestWorkflow, [row.tenantId, payload.documentId, payload.version, row.id]);
    } else {
      throw new UndeliverableError(`unknown kind ${row.kind}`);
    }
  } catch (error) {
    if (isOutage(error)) throw new OutageError((error as Error).message);
    throw error;
  }
}
