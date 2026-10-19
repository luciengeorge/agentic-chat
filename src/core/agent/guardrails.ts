/**
 * Guardrails at the server boundary (section 17.4): every write the model proposes is checked against the database
 * before anyone is asked to approve it. The findings go on the call (`ToolCall.screen`) and the policy reads them:
 * - **deny** what would cross a line: mail outside the company's own domains or to an address nobody in the
 *   directory has, an id from another tenant, a document outside the user's access;
 * - **flag** what the user should see before approving: a mail whose body quotes a document, or attaches one, that
 *   a recipient can't read;
 * - **resolve** who and what the call touches, by name, so the policy can match it against the plan.
 *
 * The tools check again when they run (`canRead`), and fake-workspace checks a third time: none of these trusts
 * the one before it.
 */
import { sql } from "drizzle-orm";

import type { Screen, ToolCall } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { canRead } from "#learn/retrieve/acl";

export interface GuardrailDeps {
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

/** Runs of this many words from the body are looked for, word for word, in the documents. */
export const QUOTE_MIN_WORDS = 8;
/** A span starts every this many words. */
export const QUOTE_STEP = 4;
/** At most this many spans are looked for in one body. */
export const MAX_QUOTES = 60;

export type Principal = { id: string; kind: "user" | "group"; name: string; email: string | null };

/** "Name <address>", or the name of a group with no address. */
export const label = (p: Principal) => (p.email ? `${p.name} <${p.email.toLowerCase()}>` : p.name);
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** The tenant's own mail domains: the domains of its directory's users. */
export async function mailDomains(tx: Tx): Promise<Set<string>> {
  const rows = await tx.execute<{ domain: string }>(sql`
    SELECT DISTINCT lower(split_part(email, '@', 2)) AS domain FROM principals
    WHERE kind = 'user' AND email IS NOT NULL`);
  return new Set(rows.map((r) => r.domain));
}

/** The enabled person or group with this address, in the tenant. */
export async function principalByEmail(tx: Tx, address: string): Promise<Principal | null> {
  const [row] = await tx.execute<Principal>(sql`
    SELECT id, kind, display_name AS name, email FROM principals
    WHERE lower(email) = lower(${address}) AND enabled`);
  return row ?? null;
}

async function principalById(tx: Tx, tenantId: string, id: string): Promise<Principal | null> {
  const [row] = await tx.execute<Principal>(sql`
    SELECT id, kind, display_name AS name, email FROM principals
    WHERE id = ${id} AND tenant_id = ${tenantId} AND enabled`);
  return row ?? null;
}

/** "Title (/path)", how the plan and the approval card name a document. */
export async function documentLabel(tx: Tx, id: string): Promise<string> {
  const [row] = await tx.execute<{ title: string; path: string }>(sql`
    SELECT title, path FROM documents WHERE id = ${id}`);
  return row ? `${row.title} (${row.path})` : id;
}

/**
 * Runs of `QUOTE_MIN_WORDS` words from the body's sentences, every few words, whitespace squashed: what counts as
 * quoting. A passage copied word for word, eleven words or longer, always contains one of them.
 */
export function quotableSpans(body: string): string[] {
  const spans = new Set<string>();
  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const w = sentence.replace(/\s+/g, " ").trim().split(" ");
    if (w.length < QUOTE_MIN_WORDS) continue;
    for (let i = 0; ; i += QUOTE_STEP) {
      const start = Math.min(i, w.length - QUOTE_MIN_WORDS);
      spans.add(w.slice(start, start + QUOTE_MIN_WORDS).join(" "));
      if (start === w.length - QUOTE_MIN_WORDS) break;
    }
  }
  return [...spans].slice(0, MAX_QUOTES);
}

/** The documents (current versions, anywhere in the tenant) whose text contains one of the spans word for word. */
export async function quotedDocuments(tx: Tx, spans: readonly string[]): Promise<Array<{ id: string; title: string }>> {
  if (spans.length === 0) return [];
  const rows = await tx.execute<{ id: string; title: string }>(sql`
    SELECT DISTINCT d.id, d.title FROM chunks c JOIN documents d ON d.id = c.document_id AND c.document_version = d.version
    WHERE ${sql.join(
      spans.map((span) => sql`strpos(lower(regexp_replace(c.text, '\\s+', ' ', 'g')), lower(${span})) > 0`),
      sql` OR `,
    )}`);
  return [...rows];
}

/** Can this principal read the document? A group stands for its members, so it can only if each of them can. */
export async function principalCanRead(tx: Tx, principal: Principal, documentId: string): Promise<boolean> {
  if (principal.kind === "user") return canRead(tx, principal.id, documentId);
  const members = await tx.execute<{ id: string }>(sql`
    SELECT gc.member_id AS id FROM group_closure gc JOIN principals p ON p.id = gc.member_id
    WHERE gc.group_id = ${principal.id} AND p.kind = 'user' AND p.enabled`);
  for (const { id } of members) if (!(await canRead(tx, id, documentId))) return false;
  return true;
}

/**
 * One mail's screen: denied when an address is outside the company's domains or nobody's in the directory, or an
 * attachment isn't one the sender can read; flagged when a recipient can't open an attachment, or the body quotes
 * a document a recipient can't read; otherwise the recipients and attachments by name, for the plan.
 */
export async function screenMail(tx: Tx, viewer: Viewer, input: Record<string, unknown>): Promise<Screen> {
  const to = Array.isArray(input.to) ? input.to.map(String) : [];
  const attachments = Array.isArray(input.attachmentDocumentIds) ? input.attachmentDocumentIds : [];
  const body = typeof input.body === "string" ? input.body : "";

  const domains = await mailDomains(tx);
  const recipients: Principal[] = [];
  for (const address of to) {
    const domain = address.split("@")[1]?.toLowerCase() ?? "";
    if (!domains.has(domain)) {
      return { deny: `mail can only go to ${[...domains].join(" or ")} addresses, and ${address} isn't one.` };
    }
    const principal = await principalByEmail(tx, address);
    if (!principal) return { deny: `nobody in your organisation's directory has the address ${address}.` };
    recipients.push(principal);
  }

  const documents: string[] = [];
  for (const id of attachments) {
    if (!isUuid(id) || !(await canRead(tx, viewer.userId, id)))
      return { deny: `no document ${String(id)} that you can read.` };
    documents.push(await documentLabel(tx, id));
  }

  const flags: string[] = [];
  for (const [i, id] of attachments.entries()) {
    const blocked = [];
    for (const r of recipients) if (!(await principalCanRead(tx, r, id))) blocked.push(r.name);
    if (blocked.length) flags.push(`${blocked.join(", ")} can't open the attachment ${documents[i]}.`);
  }
  for (const doc of await quotedDocuments(tx, quotableSpans(body))) {
    if (!(await canRead(tx, viewer.userId, doc.id))) continue;
    const blocked = [];
    for (const r of recipients) if (!(await principalCanRead(tx, r, doc.id))) blocked.push(r.name);
    if (blocked.length) flags.push(`The body quotes "${doc.title}", which ${blocked.join(", ")} can't read.`);
  }

  return { recipients: recipients.map(label), documents, ...(flags.length ? { flag: flags.join(" ") } : {}) };
}

async function screenShare(tx: Tx, viewer: Viewer, input: Record<string, unknown>): Promise<Screen> {
  const { documentId, recipientId } = input;
  if (!isUuid(documentId) || !(await canRead(tx, viewer.userId, documentId))) {
    return { deny: `no document ${String(documentId)} that you can read.` };
  }
  const recipient = isUuid(recipientId) ? await principalById(tx, viewer.tenantId, recipientId) : null;
  if (!recipient) return { deny: `${String(recipientId)} isn't a person or group in your organisation's directory.` };
  return { recipients: [label(recipient)], documents: [await documentLabel(tx, documentId)] };
}

/** The guardrails for one viewer's writes, as `RunGuard.screen`. A tool with nothing to check gets an empty screen. */
export function createGuardrails(deps: GuardrailDeps, viewer: Viewer) {
  return (calls: readonly ToolCall[]): Promise<Screen[]> =>
    deps.withTenant(viewer.tenantId, async (tx) => {
      const screens: Screen[] = [];
      for (const call of calls) {
        const input = call.input && typeof call.input === "object" ? (call.input as Record<string, unknown>) : {};
        if (call.tool === "send_mail") screens.push(await screenMail(tx, viewer, input));
        else if (call.tool === "share_document") screens.push(await screenShare(tx, viewer, input));
        else screens.push({});
      }
      return screens;
    });
}
