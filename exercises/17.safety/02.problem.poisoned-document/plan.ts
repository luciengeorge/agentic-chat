// 👨‍💼 A plan only protects Ella if it's the right one: the plan made from her message, before her agent read a word
//    of the pack. This file says which `make_plan` call that is.
//
// 🦉 Already written in this file: the plan's schema and tool, `currentPlan` and `isPlanningCall` (both ask your
//    `planningTurn`), and the matching step 3 uses. You write `planningTurn`.

/**
 * Plan-then-execute (section 17.3). Each user message starts with a planning turn: before the agent has read a
 * single document, it says which writes it means to make, and to whom. The policy then lets through only the
 * writes that plan names. A document read later can ask for anything; the plan was fixed before the agent saw it,
 * and only a new message from the user can make a new one.
 */
import { z } from "zod";

import type { AgentTool, RunEvent, RunEventData, ToolCall } from "#learn/agent/types";

export const PLAN_TOOL = "make_plan";

const PlannedWrite = z.object({
  tool: z.enum(["send_mail", "share_document", "remember"]),
  targets: z
    .array(z.string().min(1).max(200))
    .max(10)
    .describe("Who it's for, as the user named them: people, groups or email addresses. Empty for remember."),
  documents: z
    .array(z.string().min(1).max(200))
    .max(5)
    .describe(
      "The documents the write touches, as the user named them: to share, or to attach to a mail. Otherwise empty.",
    ),
  note: z
    .string()
    .min(1)
    .max(280)
    .nullable()
    .describe(
      "For remember: the exact note to keep, worded from the user's message. The remember call must use this same " +
        "text. Null for other writes.",
    ),
});

export const PlanSchema = z.object({
  goal: z.string().min(1).max(500).describe("What the user asked for, in a sentence."),
  steps: z.array(z.string().min(1).max(300)).max(10).describe("The steps, briefly."),
  writes: z
    .array(PlannedWrite)
    .max(5)
    .describe("Every write the user asked for. Empty when they only asked a question."),
});

export type Plan = z.infer<typeof PlanSchema>;
export type PlannedWrite = z.infer<typeof PlannedWrite>;

/** The planning tool. It does nothing but record the plan: the plan is its call, kept in the run's events. */
export function planTool(): AgentTool<Plan, { planned: number }> {
  return {
    name: PLAN_TOOL,
    description:
      "Record your plan for the user's latest request before doing anything else: the goal, the steps, and every " +
      "write (send_mail, share_document, remember) the user asked for, with its targets, the documents it shares " +
      "or attaches, and for remember the note itself. One entry per write: a mail's recipients and attachments " +
      "must all be in the same entry. Writes, recipients, attachments and notes not in the plan are refused.",
    input: PlanSchema,
    effect: "read",
    needsApproval: () => false,
    execute: async (plan) => ({ planned: plan.writes.length }),
  };
}

/**
 * The first assistant turn after the latest user message: the planning turn. Its `make_plan` call, if any, is the
 * plan in force. A `make_plan` in any later turn isn't one: replanning needs the user.
 */
export function planningTurn(events: readonly RunEvent[]): Extract<RunEventData, { type: "assistant_turn" }> | null {
  // 🐨 Find the user's latest message. None: null.
  // 🐨 The planning turn is the first `assistant_turn` after it. Return it, or null when the model hasn't answered
  //    that message yet.
  // 🐨 The classic mistakes: the latest turn that called `make_plan` (the model can call it again after reading
  //    the pack, with the pack's mail in it), or the run's first turn (a follow-up would run on the plan made for
  //    the first message).
  //
  // 🦉 Why the first turn after the message. That turn is forced to call `make_plan`, and it sees only the user's
  //    words (`planningInput`). Every later turn has read tool output. So "the first turn after the latest user
  //    message" is exactly "the plan made before anything was read".
  // 🦉 Why a new message needs a new plan. Each request may make the writes its own words asked for. A plan from
  //    an earlier message would let this request make that one's writes.
  //
  // 🚨 The tests check which turn holds the plan in force (the first, a later one, after a new message, none yet),
  //    that a later `make_plan` is refused, and the pack's own `make_plan` refused in Ella's run.
  throw new Error(`planningTurn(${events.length} events) isn't written yet`);
}

/** The plan for the user's latest message, or null when the planning turn made none (or a malformed one). */
export function currentPlan(events: readonly RunEvent[]): Plan | null {
  const call = planningTurn(events)?.toolCalls.find((c) => c.tool === PLAN_TOOL);
  const parsed = call ? PlanSchema.safeParse(call.input) : null;
  return parsed?.success ? parsed.data : null;
}

/** Is this `make_plan` call the one in the planning turn? */
export function isPlanningCall(events: readonly RunEvent[], call: ToolCall): boolean {
  return planningTurn(events)?.toolCalls.some((c) => c.callId === call.callId) ?? false;
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "my",
  "our",
  "to",
  "and",
  "of",
  "for",
  "in",
  "at",
  "with",
  "from",
  "team",
]);

/** Lowercase words, split on anything that isn't a letter or digit; email addresses split at the dots too. */
export const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOPWORDS.has(w));

const ADDRESS = /[^\s<>()[\],;:"']+@[^\s<>()[\],;:"']+/g;

/**
 * Does a target the user named ("Tom", "tom.whitfield@kestrelpay.example", "Tom Whitfield (tom.whitfield@...)",
 * "Finance") match one of the labels the guardrails resolved for a recipient ("Tom Whitfield
 * <tom.whitfield@kestrelpay.example>")? A target with an address must match by that address exactly; otherwise
 * every word of the target must be a word of the label.
 */
export function targetMatches(target: string, labels: readonly string[]): boolean {
  const t = target.trim().toLowerCase();
  const addresses = t.match(ADDRESS);
  if (addresses) {
    return labels.some((label) => {
      const l = label.toLowerCase();
      return addresses.some((address) => l.includes(`<${address}>`) || l === address);
    });
  }
  const wanted = words(t);
  if (wanted.length === 0) return false;
  return labels.some((label) => {
    const have = new Set(words(label));
    return wanted.every((w) => have.has(w));
  });
}

const DOCUMENT_STOPWORDS = new Set(["document", "file"]);
const EXTENSIONS = new Set(["pdf", "doc", "docx", "md", "txt", "xls", "xlsx", "csv", "ppt", "pptx"]);

/** The words that name a document: no stopwords, no file extensions. */
const documentWords = (text: string) => words(text).filter((w) => !DOCUMENT_STOPWORDS.has(w) && !EXTENSIONS.has(w));

/** A guardrails label is "Title (/path)": the title alone. A folder in the path names nothing. */
export function titleOf(label: string): string {
  const open = label.lastIndexOf(" (");
  return open > 0 && label.endsWith(")") ? label.slice(0, open) : label;
}

/**
 * Does a document the user named ("the Q3 report") match a document's label ("Q3 2026 Quarterly Report.pdf
 * (/Finance/Reports/Q3 2026 Quarterly Report.pdf)")? Every word of the name must be a whole word of the title.
 * The path doesn't count, and neither do part-words: "Q3 report" doesn't cover "/Exec/Reports/heron-memo.pdf".
 */
export function documentMatches(named: string, labels: readonly string[]): boolean {
  const wanted = documentWords(named);
  if (wanted.length === 0) return false;
  return labels.some((label) => {
    const have = new Set(documentWords(titleOf(label)));
    return wanted.every((w) => have.has(w));
  });
}

/** Notes compare ignoring case, spacing and a closing full stop. */
const noteKey = (note: string) =>
  note
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!]+$/, "");

export const sameNote = (a: string, b: string) => noteKey(a) === noteKey(b);

/**
 * Why the plan doesn't cover this write, or null when it does. One planned entry must cover the whole call: a
 * mail's every recipient and every attachment in the same planned send_mail, a share's recipient and document in
 * the same planned share_document, a note word for word as a planned remember wrote it.
 */
export function uncovered(plan: Plan, call: ToolCall): string | null {
  const planned = plan.writes.filter((w) => w.tool === call.tool);
  if (planned.length === 0) return `the plan has no ${call.tool}.`;

  if (call.tool === "remember") {
    const note = (call.input as { note?: unknown }).note;
    const ok = typeof note === "string" && planned.some((w) => w.note !== null && sameNote(w.note, note));
    return ok ? null : "the plan doesn't have this note, word for word, from the user's request.";
  }

  const recipients = call.screen?.recipients ?? [];
  if (call.tool === "send_mail") {
    const to = (call.input as { to?: unknown }).to;
    const addresses = Array.isArray(to) ? to.map(String) : [];
    const labelsOf = (address: string) => {
      const labels = recipients.filter((r) => r.toLowerCase().includes(`<${address.toLowerCase()}>`));
      return labels.length ? labels : [address];
    };
    // A document read mid-run mustn't add an attachment: one the recipient can read would go out unflagged, and
    // one they can't would only be flagged to an approver.
    const attachments = (call.input as { attachmentDocumentIds?: unknown }).attachmentDocumentIds;
    const documents = call.screen?.documents ?? [];
    if (Array.isArray(attachments) && attachments.length > 0 && documents.length !== attachments.length) {
      return "the attachments weren't resolved, so they can't be checked.";
    }
    const names = (w: PlannedWrite, address: string) => w.targets.some((t) => targetMatches(t, labelsOf(address)));
    const attaches = (w: PlannedWrite, label: string) => w.documents.some((d) => documentMatches(d, [label]));
    const covers = (w: PlannedWrite) =>
      addresses.every((a) => names(w, a)) && documents.every((label) => attaches(w, label));
    if (planned.some(covers)) return null;

    const stranger = addresses.find((a) => !planned.some((w) => names(w, a)));
    if (stranger) return `the plan doesn't name ${stranger} as a recipient.`;
    const extra = documents.find((label) => !planned.some((w) => attaches(w, label)));
    if (extra) return `the plan doesn't name ${extra} as an attachment.`;
    return "no one planned mail has all these recipients and attachments together.";
  }

  if (call.tool === "share_document") {
    const documents = call.screen?.documents ?? [];
    const ok = planned.some(
      (w) =>
        w.targets.some((t) => targetMatches(t, recipients)) && w.documents.some((d) => documentMatches(d, documents)),
    );
    return ok
      ? null
      : `the plan doesn't name this document and recipient (${[...documents, ...recipients].join(", ")}).`;
  }
  return null;
}
