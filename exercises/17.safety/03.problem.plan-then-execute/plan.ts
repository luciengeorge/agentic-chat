// 👨‍💼 The plan says which writes Grace's request may make. This file checks a write against it: Tom, whom the plan
//    names, can get the mail; a colleague a document mentioned, or an attachment the plan never named, can't.
//
// 🦉 Already written in this file: the plan, `planningTurn` (step 2), `targetMatches` (a recipient's label
//    against a planned target), `documentMatches` (an attachment's label against a planned document: every word
//    of the planned name a whole word of the title) and `sameNote`. You write `uncovered`.

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
  let lastMessage = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].data.type === "user_message") {
      lastMessage = i;
      break;
    }
  }
  if (lastMessage === -1) return null;
  for (let i = lastMessage + 1; i < events.length; i++) {
    const data = events[i].data;
    if (data.type === "assistant_turn") return data;
  }
  return null;
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
  // 🐨 Only the plan's entries for this call's tool count. None: "the plan has no <tool>."
  // 🐨 `remember`: the call's `note` must equal a planned entry's `note` (`sameNote`). Else "the plan doesn't have
  //    this note, word for word, from the user's request."
  // 🐨 `send_mail`: one planned entry must cover the whole mail, every address in `input.to` (`targetMatches`
  //    against that address's label in `call.screen.recipients`) and every attachment (`documentMatches` on each
  //    label in `call.screen.documents`). If the screen resolved fewer attachments than the input names, refuse:
  //    "the attachments weren't resolved, so they can't be checked."
  // 🐨 A mail no entry covers gets the most useful reason: an address no entry names ("the plan doesn't name
  //    <address> as a recipient."), else an attachment no entry names ("the plan doesn't name <label> as an
  //    attachment."), else "no one planned mail has all these recipients and attachments together."
  // 🐨 `share_document`: one planned entry must name its recipient and its document together. Else "the plan
  //    doesn't name this document and recipient (<the documents and recipients, joined with ", ">)."
  // 🐨 Covered: null.
  // 🐨 The classic mistake: covering one call from several entries. Plan "mail Tom" and "mail Daniel the Heron
  //    memo", and a mail to Tom with the memo attached passes recipient by recipient and attachment by attachment.
  //    It's still a mail nobody planned.
  //
  // 💰 A recipient's label looks like "Tom Whitfield <tom.whitfield@kestrelpay.example>": an address's label is
  //    the one containing `<address>`, in lower case (if none does, use the address). `array.every`, `.some`,
  //    `.find`, `.filter`.
  //
  // 🦉 Why one entry per call. An entry is one thing the user asked for. Mixing entries lets a document rewire the
  //    user's requests: move the memo from Daniel's mail onto Tom's, and every piece still looks planned.
  // 🦉 Why titles and whole words. In M2's first plan check, "Q3 report" covered `/Exec/Reports/heron-memo.pdf`:
  //    "report" was the start of a folder's name. `documentMatches` takes whole words of the title only, so a
  //    folder or half a word can't make a document look planned.
  // 🦉 Why the guardrails' labels. The model writes an address; the guardrails (step 4) look it up and say whose it
  //    is. Matching the plan against that label means "Tom Whitfield" in the plan covers Tom's real address, and
  //    "Tom (attacker@evil.example)" covers the attacker's alone.
  //
  // 🚨 The tests check Grace's recorded mail (covered), a colleague added, an attachment nobody planned, two entries
  //    mixed into one mail, a path word, a share's pair, and a note.
  throw new Error(`uncovered(${plan.writes.length} planned writes, ${call.tool}) isn't written yet`);
}
