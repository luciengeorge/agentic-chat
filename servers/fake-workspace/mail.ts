/**
 * Graph's `POST /v1.0/users/{id}/sendMail`, kept in memory: nothing is delivered anywhere. The control API lists
 * what was sent (`GET /_control/mail`), so tests and smoke checks can count sends.
 */
import type { Hono } from "hono";

import { z } from "zod";

import type { Runtime } from "./app";
import type { Directory } from "./directory";
import type { Item, Site } from "./site";

import { iso } from "./clock";
import { GraphError, badRequest, notFound } from "./errors";
import { readBody, subscriber } from "./http";

/** A file in the drive, attached by reference: `sourceUrl` ends in `/drives/{drive}/items/{item}`. */
const ReferenceAttachmentSchema = z.object({
  "@odata.type": z.literal("#microsoft.graph.referenceAttachment"),
  name: z.string().min(1),
  sourceUrl: z.string().regex(/\/drives\/[^/]+\/items\/[^/?#]+$/, "must end in /drives/{drive}/items/{item}"),
});

const SendMailSchema = z.object({
  message: z.object({
    subject: z.string().max(500),
    body: z.object({ contentType: z.enum(["Text", "HTML"]), content: z.string().max(100_000) }),
    toRecipients: z
      .array(z.object({ emailAddress: z.object({ address: z.email() }) }))
      .min(1)
      .max(50),
    ccRecipients: z
      .array(z.object({ emailAddress: z.object({ address: z.email() }) }))
      .max(50)
      .default([]),
    attachments: z.array(ReferenceAttachmentSchema).max(10).default([]),
  }),
  saveToSentItems: z.boolean().default(true),
});

export interface SentMail {
  readonly id: string;
  readonly site: string;
  readonly from: { readonly id: string; readonly address: string };
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly attachments: readonly { readonly itemId: string; readonly name: string }[];
  readonly idempotencyKey: string | null;
  readonly sentAt: string;
}

export class Mailroom {
  readonly sent: SentMail[] = [];

  clear(): void {
    this.sent.length = 0;
  }
}

/** The groups a user is in, directly or through nesting: a group's path is a prefix of one of theirs. */
function inGroup(groups: readonly string[], path: string): boolean {
  return groups.some((p) => p === path || p.startsWith(`${path}/`));
}

/** Whether an enabled user holds a grant on the item, themselves or through a group. */
export function userCanRead(site: Site, directory: Directory, userId: string, item: Item): boolean {
  const user = directory.users.find((u) => u.id === userId);
  if (!user?.enabled) return false;
  return site
    .effective(item)
    .some(({ grant }) =>
      grant.principal_type === "user"
        ? grant.principal_id === userId
        : inGroup(user.groups, directory.groups.find((g) => g.id === grant.principal_id)?.path ?? "\0"),
    );
}

export function mailRoutes(app: Hono, rt: Runtime): void {
  app.post("/v1.0/users/:userId/sendMail", async (c) => {
    const body = await readBody(c, SendMailSchema);
    const siteName = await subscriber(c, rt);
    const site = rt.workspace.sites.get(siteName)!;
    const directory = rt.workspace.directories.get(siteName)!;
    const userId = c.req.param("userId");

    return rt.idempotency.run(c, siteName, body, () => {
      const sender = directory.users.find((u) => u.id === userId);
      if (!sender) throw notFound("No such user.");
      if (!sender.enabled) throw new GraphError(403, "accessDenied", "The sender's account is disabled.");

      // The second line of defence: the agent checked the attachments, and the service checks them again.
      const attachments = body.message.attachments.map((attachment) => {
        const [, drive, itemId] = /\/drives\/([^/]+)\/items\/([^/?#]+)$/.exec(attachment.sourceUrl)!;
        if (drive !== siteName) throw badRequest(`Attachment ${attachment.name}: not in this site's drive.`);
        let item: Item;
        try {
          item = site.get(itemId!);
        } catch {
          throw badRequest(`Attachment ${attachment.name}: no such item.`);
        }
        if (item.folder) throw badRequest(`Attachment ${attachment.name}: a folder can't be attached.`);
        if (!userCanRead(site, directory, userId, item)) {
          throw new GraphError(403, "accessDenied", `The sender can't read the attachment ${attachment.name}.`);
        }
        return { itemId: item.id, name: attachment.name };
      });

      const address = (r: { emailAddress: { address: string } }) => r.emailAddress.address;
      rt.mailroom.sent.push({
        id: crypto.randomUUID(),
        site: siteName,
        from: { id: sender.id, address: sender.email },
        to: body.message.toRecipients.map(address),
        cc: body.message.ccRecipients.map(address),
        subject: body.message.subject,
        body: body.message.body.content,
        attachments,
        idempotencyKey: c.req.header("idempotency-key") ?? null,
        sentAt: iso(rt.clock.now()),
      });
      return { status: 202, body: null };
    });
  });

  /** Everything sent since the last reset, oldest first. Behind the control API's checks. */
  app.get("/_control/mail", (c) => c.json({ value: rt.mailroom.sent }));
}
