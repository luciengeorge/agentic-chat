import { sql } from "drizzle-orm";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import { notReadable, readableDocument, type ToolDeps } from "./deps";

const Input = z.object({
  documentId: z.uuid(),
  recipientId: z.uuid().describe("A person's or group's id, from find_person."),
  role: z.enum(["read"]),
});

interface Output {
  shared: true;
  documentId: string;
  title: string;
  recipient: string;
  role: "read";
}

/**
 * Shares a document the viewer can read with a person or group in their tenant, after the viewer's approval. The
 * drive's new permission comes back through ACL sync, like any other sharing change.
 */
export function shareDocument(
  deps: Pick<ToolDeps, "withTenant" | "workspace">,
): AgentTool<z.infer<typeof Input>, Output> {
  return {
    name: "share_document",
    description:
      "Give a person or group read access to a document the user can read. The user approves it before it happens.",
    input: Input,
    effect: "write",
    needsApproval: () => true,
    async execute({ documentId, recipientId, role }, ctx) {
      const { userId, tenantId } = ctx.viewer;
      const { document, recipient } = await deps.withTenant(tenantId, async (tx) => {
        const document = await readableDocument(tx, userId, documentId);
        if (!document) throw notReadable(documentId);
        const [recipient] = await tx.execute<{ name: string }>(sql`
          SELECT display_name AS name FROM principals WHERE id = ${recipientId} AND enabled`);
        if (!recipient) throw new Error(`No person or group ${recipientId} in the directory.`);
        return { document, recipient };
      });
      const workspace = await deps.workspace(tenantId);
      await workspace.invite(document.externalId, recipientId, ctx.idempotencyKey, ctx.signal);
      return { shared: true, documentId, title: document.title, recipient: recipient.name, role };
    },
  };
}
