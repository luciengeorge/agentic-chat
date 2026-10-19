import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import { notReadable, readableDocument, type ToolDeps } from "#learn/agent/tools/deps";

const Input = z.object({
  to: z.array(z.email()).min(1).max(10).describe("Recipients' email addresses."),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000).describe("Plain text."),
  attachmentDocumentIds: z.array(z.uuid()).max(5).describe("Document ids to attach; empty for none."),
});

interface Output {
  sent: true;
  to: string[];
  subject: string;
  attachments: string[];
}

/**
 * Sends a mail as the viewer, after their approval. Every attachment passes `canRead` before anything leaves, and
 * the call's idempotency key goes with it, so a retry never sends twice.
 */
export function sendMail(deps: Pick<ToolDeps, "withTenant" | "workspace">): AgentTool<z.infer<typeof Input>, Output> {
  return {
    name: "send_mail",
    description:
      "Send an email from the user, optionally attaching documents they can read. The user approves it before it " +
      "is sent.",
    input: Input,
    effect: "write",
    needsApproval: () => true,
    async execute(input, ctx) {
      const { userId, tenantId } = ctx.viewer;
      const documents = await deps.withTenant(tenantId, async (tx) => {
        const found = [];
        for (const id of new Set(input.attachmentDocumentIds)) {
          const document = await readableDocument(tx, userId, id);
          if (!document) throw notReadable(id);
          found.push(document);
        }
        return found;
      });
      const workspace = await deps.workspace(tenantId);
      await workspace.sendMail(
        userId,
        {
          to: input.to,
          subject: input.subject,
          body: input.body,
          attachments: documents.map((d) => ({ itemId: d.externalId, name: d.title })),
        },
        ctx.idempotencyKey,
        ctx.signal,
      );
      return { sent: true, to: input.to, subject: input.subject, attachments: documents.map((d) => d.title) };
    },
  };
}
