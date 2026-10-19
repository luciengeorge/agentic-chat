// 👨‍💼 Sharing changes who can read a document, from now on. Grace's agent may share only what Grace can read, only
//    with people in Kestrel, and fake-workspace checks it again as Grace.
//
// 🦉 Already written in this file: the input schema and the description. You write `execute`.

import { z } from "zod";

import type { ToolDeps } from "#learn/agent/tools/deps";
import type { AgentTool } from "#learn/agent/types";

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
 * drive's new permission comes back through ACL sync, like any other sharing change. The service checks the
 * viewer can read the item too, as a second line.
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
      // 🐨 In one tenant transaction, as `ctx.viewer`: the document must be one the user can read now (else
      //    `notReadable`), and the recipient an enabled person or group of the user's own tenant (else "No person
      //    or group <recipientId> in your organisation's directory.").
      // 🐨 Then invite through the tenant's workspace writer as the acting user: the user, the document's drive
      //    item id, the recipient, `ctx.idempotencyKey`, `ctx.signal`.
      // 🐨 Return `{ shared: true, documentId, title, recipient, role }`, with the recipient's display name.
      // 🐨 The classic mistake: sharing as anyone but the user. The invite's acting user is who the drive checks.
      //    The recipient, or no one, would let Grace share what she can't open.
      //
      // 💰 `tx.execute<{ name: string }>(sql\`SELECT display_name AS name FROM principals WHERE ...\`)`; add
      //    `import { sql } from "drizzle-orm";` and `notReadable` and `readableDocument` to the deps import.
      //    `(await deps.workspace(tenantId)).invite(actingUserId, itemId, recipientId, key, signal)`.
      //
      // 🦉 Why fake-workspace gets the acting user. The invite carries `X-Acting-User`, which names the user it's
      //    made for, and the drive refuses a user who can't read the item. That's the second line: with a bug in
      //    this tool, the drive would still refuse.
      // 🦉 Why name the tenant in the query. RLS (section 09) already hides Harbour's people from a Kestrel
      //    transaction. Writing `tenant_id = <the viewer's>` too keeps the check true in code that runs without
      //    RLS, such as a job on the owner's connection.
      //
      // 🚨 The tests check a share with Tom (invited as Grace), the Heron memo refused, Nina at Harbour refused, a
      //    disabled colleague refused, and nothing sent for a refusal.
      throw new Error(
        `share_document isn't written yet (${documentId} with ${recipientId}, ${role}, ${ctx.callId}, ${typeof deps})`,
      );
    },
  };
}
