import { sql } from "drizzle-orm";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import { notReadable, readableDocument, type ToolDeps } from "./deps";

/** About six pages of text per call: enough to read a memo, and the model can ask for the rest. */
export const READ_DOCUMENT_TOKENS = 3000;

const Input = z.object({
  documentId: z.uuid().describe("The document's id, from search_documents."),
  fromChunk: z.int().min(0).nullable().describe("Where to continue: the nextChunk of an earlier read; null to start."),
});

interface Output {
  documentId: string;
  title: string;
  path: string;
  chunks: Array<{
    chunkId: string;
    section: string | null;
    pageStart: number | null;
    pageEnd: number | null;
    text: string;
  }>;
  /** Pass it as `fromChunk` to read on; null at the end. */
  nextChunk: number | null;
}

/** A document's chunks in order, as the viewer, up to a token cap. `canRead` first: Postgres decides. */
export function readDocument(
  deps: Pick<ToolDeps, "withTenant">,
  maxTokens = READ_DOCUMENT_TOKENS,
): AgentTool<z.infer<typeof Input>, Output> {
  return {
    name: "read_document",
    description:
      "Read a document the user can read, in order, about six pages at a time. If nextChunk isn't null, call again " +
      "with fromChunk set to it to read on.",
    input: Input,
    effect: "read",
    needsApproval: () => false,
    execute: ({ documentId, fromChunk }, ctx) =>
      deps.withTenant(ctx.viewer.tenantId, async (tx) => {
        const document = await readableDocument(tx, ctx.viewer.userId, documentId);
        if (!document) throw notReadable(documentId);
        const rows = await tx.execute<{
          id: string;
          section: string | null;
          page_start: number | null;
          page_end: number | null;
          text: string;
          token_count: number;
        }>(sql`
          SELECT id, section, page_start, page_end, text, token_count FROM chunks
          WHERE document_id = ${documentId} AND document_version = ${document.version}
          ORDER BY ordinal`);
        const start = fromChunk ?? 0;
        const chunks: Output["chunks"] = [];
        let tokens = 0;
        let next = start;
        // Always one chunk, so a chunk over the cap can't stall the reader.
        while (next < rows.length && (chunks.length === 0 || tokens + rows[next].token_count <= maxTokens)) {
          const row = rows[next];
          tokens += row.token_count;
          chunks.push({
            chunkId: row.id,
            section: row.section,
            pageStart: row.page_start,
            pageEnd: row.page_end,
            text: row.text,
          });
          next += 1;
        }
        return {
          documentId,
          title: document.title,
          path: document.path,
          chunks,
          nextChunk: next < rows.length ? next : null,
        };
      }),
  };
}
