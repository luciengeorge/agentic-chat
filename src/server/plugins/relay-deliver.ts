import { start } from "workflow/api";

import { CONVERSATION_LOG_KIND, deliverConversationLog, type Exporter } from "#learn/observability/conversation-log";
import { type OutboxRow, OutageError, UndeliverableError } from "@/db/outbox";
import { processConversationLog } from "@/lib/observability.server";
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

/**
 * Starts the workflow an outbox row asks for, or hands a conversation log row to the exporter (`conversationLog`,
 * this process's unless given). The run's first step, or the exporter, claims the row, so a second delivery is
 * harmless.
 */
export async function deliver(
  row: OutboxRow,
  conversationLog: () => Exporter | null = processConversationLog,
): Promise<void> {
  try {
    if (row.kind === "sync") {
      const payload = SyncPayload(row.payload);
      if (!payload) throw new UndeliverableError(`bad sync payload ${JSON.stringify(row.payload)}`);
      await start(syncWorkflow, [row.tenantId, row.id, payload.mode]);
    } else if (row.kind === "ingest") {
      const payload = IngestPayload(row.payload);
      if (!payload) throw new UndeliverableError(`bad ingest payload ${JSON.stringify(row.payload)}`);
      await start(ingestWorkflow, [row.tenantId, payload.documentId, payload.version, row.id]);
    } else if (row.kind === CONVERSATION_LOG_KIND) {
      deliverConversationLog(row, conversationLog());
    } else {
      throw new UndeliverableError(`unknown kind ${row.kind}`);
    }
  } catch (error) {
    if (isOutage(error)) throw new OutageError((error as Error).message);
    throw error;
  }
}
