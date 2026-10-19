// 👨‍💼 The guardrails are the last check on the server before Grace is asked to approve a write. They know what the
//    model can't: which domains are Kestrel's, who's in the directory, who can open which document. A mail to the
//    Brightwell data room is refused here even if every other layer missed it.
//
// 🦉 Already written in this file: the lookups (`mailDomains`, `principalByEmail`, `documentLabel`,
//    `quotedDocuments`, `principalCanRead`), `screenShare`, and `createGuardrails`, which `modelTurn` calls for the
//    writes a turn proposes. You write `quotableSpans` and `screenMail`.

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
  // 🐨 Split the body into sentences and lines. In each one of at least `QUOTE_MIN_WORDS` words (whitespace squashed
  //    to single spaces), take runs of `QUOTE_MIN_WORDS` words starting every `QUOTE_STEP` words, and always the
  //    sentence's last `QUOTE_MIN_WORDS` words.
  // 🐨 No run twice, and at most `MAX_QUOTES` of them.
  //
  // 💰 `text.split(/(?<=[.!?])\s+|\n+/)` splits after a sentence's end and at line breaks.
  //    `s.replace(/\s+/g, " ").trim().split(" ")`. A `Set` keeps the first of each.
  //
  // 🦉 Why every 4 words. Checking every 8-word run would be one search per word of the body. Starting a run every
  //    4 words is a quarter of that, and still can't miss a long quote: a passage copied word for word starts at
  //    most 3 words before a run does, so with 11 words or more (3 + 8) it holds a whole run.
  // 🦉 Why 8 words. Shorter runs match by chance: "the board votes on" is in plenty of documents. Eight words in a
  //    row from one document is a quote.
  //
  // 🚨 The tests check the runs of a short and a long sentence, the last run, squashed spaces, and an 11-word quote
  //    found wherever it starts.
  throw new Error(`quotableSpans(${body.length} characters) isn't written yet`);
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
  // 🐨 Every address in `input.to` must be at one of the tenant's mail domains (`mailDomains`: the domains of its
  //    directory's users) and belong to an enabled person or group there (`principalByEmail`). Else deny: "mail can
  //    only go to <the domains, joined with " or "> addresses, and <address> isn't one." or "nobody in your
  //    organisation's directory has the address <address>."
  // 🐨 Every attachment must be a uuid the sender can read (`canRead` as `viewer.userId`). Else deny: "no document
  //    <id> that you can read."
  // 🐨 Then flag, without denying, what the user should see before approving: an attachment a recipient can't open
  //    ("<names> can't open the attachment <label>."), and a document the body quotes that a recipient can't read
  //    ('The body quotes "<title>", which <names> can't read.'). Only quoted documents the sender can read count.
  // 🐨 Return the recipients' labels, the attachments' labels, and the flags joined with a space (no `flag` when
  //    there's none).
  // 🐨 The classic mistake: checking the domain by its ending. "tom@kestrelpay.example.evil.example" and
  //    "dataroom@evil-kestrelpay.example" both end in something that looks right. Compare the whole domain.
  //
  // 💰 `address.split("@")[1]?.toLowerCase()`. `isUuid(id)`. `principalCanRead(tx, principal, documentId)` covers
  //    a group too. `label(principal)`, `documentLabel(tx, id)`, `quotedDocuments(tx, quotableSpans(body))`.
  //
  // 🦉 Why deny some and flag others. Mail outside Kestrel, to an address nobody has, or carrying a document Grace
  //    can't read is never right: deny. Tom being unable to open an attachment may be fine (the sender may mean to
  //    share it next) or may be a leak. Only a person can tell, so it goes to the approver with the reason.
  // 🦉 Why here, on the server. The model proposed the mail, and the plan says the user asked for one. Neither knows
  //    Kestrel's domains or who can read the Heron memo. The guardrails ask Postgres, inside the tenant, where those
  //    facts live, and their findings ride on the call (`ToolCall.screen`) for the policy to read.
  // 🦉 Why only documents the sender can read. A flag naming a document Grace can't open would tell her it exists,
  //    and its title. Her own words matching it are chance, never a leak.
  // 🦉 Three lines, none trusting the one before. The guardrails deny here, the tool checks `canRead` again when it
  //    runs (step 1), and fake-workspace refuses an attachment the sender can't read. A bug in one doesn't open
  //    the door.
  //
  // 🚨 The tests check the Brightwell data room, a mistyped address, two lookalike domains, Harbour, an attachment
  //    Grace can't read, Tom unable to open Daniel's attachment, and Daniel's body quoting the Heron memo to Tom.
  throw new Error(`screenMail isn't written yet (${viewer.userId}, ${Object.keys(input).join(", ")}, ${typeof tx})`);
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
