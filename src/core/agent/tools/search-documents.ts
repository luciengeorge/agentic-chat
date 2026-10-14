import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import type { ToolDeps } from "./deps";

const Input = z.object({
  query: z.string().min(1).max(500).describe("What to look for, in plain words."),
  k: z.int().min(1).max(8).nullable().describe("How many passages to return, 1 to 8 (default 8)."),
});

export interface FoundPassage {
  chunkId: string;
  documentId: string;
  title: string;
  path: string;
  pageStart: number | null;
  pageEnd: number | null;
  text: string;
}

/** Hybrid search over the documents the viewer can read: `retrieve`, which filters by ACL and audits the call. */
export function searchDocuments(
  deps: Pick<ToolDeps, "retrieve">,
): AgentTool<z.infer<typeof Input>, { passages: FoundPassage[] }> {
  return {
    name: "search_documents",
    description:
      "Search the company documents the user can read. Returns the best passages with their document ids, titles, " +
      "paths and pages. Use read_document to read a whole document.",
    input: Input,
    effect: "read",
    needsApproval: () => false,
    async execute({ query, k }, ctx) {
      const { chunks } = await deps.retrieve(ctx.viewer, query, { k: k ?? 8 });
      return {
        passages: chunks.map((c) => ({
          chunkId: c.id,
          documentId: c.documentId,
          title: c.title,
          path: c.path,
          pageStart: c.pageStart,
          pageEnd: c.pageEnd,
          text: c.text,
        })),
      };
    },
  };
}
