// 👨‍💼 Grace's agent sends mail as Grace. It has no access of its own, so a mail can only carry what Grace herself
//    can open: a document outside her access must never leave as an attachment, however the model came to ask.
//
// 🦉 Already written in this file: the input schema and the description the model reads. You write `execute`.

import { z } from "zod";

import type { ToolDeps } from "#learn/agent/tools/deps";
import type { AgentTool } from "#learn/agent/types";

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
      // 🐨 Before anything leaves, check every attachment as the acting user (`ctx.viewer`), in their tenant: each
      //    must be a document they can read now. One they can't, or one that doesn't exist, stops the whole call
      //    with `notReadable(id)`, the same words either way.
      // 🐨 Then send through the tenant's workspace writer, from the user, with each attachment's drive item id and
      //    title, the call's `ctx.idempotencyKey` and `ctx.signal`.
      // 🐨 Return `{ sent: true, to, subject, attachments }`, the attachments as their titles.
      // 🐨 The classic mistake: trusting the ids because the model found them by searching. Search only shows what
      //    the user can read, but the model can write any uuid it likes: from a document's text, an earlier turn,
      //    or thin air.
      //
      // 💰 `deps.withTenant(tenantId, async (tx) => ...)`. `readableDocument(tx, userId, id)` is null for a
      //    document the user can't read or that doesn't exist; add `import { notReadable, readableDocument } from
      //    "#learn/agent/tools/deps";` (and keep `type ToolDeps` in it). `(await deps.workspace(tenantId))
      //    .sendMail(userId, { to, subject, body, attachments: [{ itemId, name }] }, key, signal)`. A document's
      //    drive item id is its `externalId`. `new Set(ids)` drops a repeated id.
      //
      // 🦉 Why as the user. Every tool acts with exactly the permissions of the person who asked. So the question
      //    for each attachment is "can Grace read this?", asked of Postgres (`canRead` inside `readableDocument`),
      //    which section 09 made the one place access is decided.
      // 🦉 Why the same words for missing and forbidden. "That document exists but you can't read it" would tell
      //    Grace the Heron memo is real. Her answer has to be the one an id nobody ever used gets.
      // 🦉 Why check them all before sending. A mail whose third attachment is refused must send nothing. Checking
      //    as you go would already have sent the first two.
      //
      // 🚨 The tests check Grace mailing Tom the Q3 report (sent as her, with its item id and the call's key), the
      //    Heron memo refused with nothing sent, a made-up id refused in the same words, and a retry sent once.
      throw new Error(`send_mail isn't written yet (to ${input.to.join(", ")}, call ${ctx.callId}, ${typeof deps})`);
    },
  };
}
