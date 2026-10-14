/**
 * Plan-then-execute (section 17.3). Each user message starts with a planning turn: before the agent has read a
 * single document, it says which writes it means to make, and to whom. The policy then lets through only the
 * writes that plan names. A document read later can ask for anything; the plan was fixed before the agent saw it,
 * and only a new message from the user can make a new one.
 */
import { z } from "zod";

import type { AgentTool, RunEvent, ToolCall } from "./types";

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
    .describe("For share_document: the documents to share, as the user named them. Otherwise empty."),
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
      "write (send_mail, share_document, remember) the user asked for, with its targets. Writes not in the plan " +
      "are refused.",
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
function planningTurn(events: readonly RunEvent[]) {
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

/**
 * Does a target the user named ("Tom", "tom.whitfield@kestrelpay.example", "Finance") match one of the labels the
 * guardrails resolved for a recipient ("Tom Whitfield <tom.whitfield@kestrelpay.example>")? An address must match
 * exactly; otherwise every word of the target must be a word of the label.
 */
export function targetMatches(target: string, labels: readonly string[]): boolean {
  const t = target.trim().toLowerCase();
  if (t.includes("@"))
    return labels.some((label) => label.toLowerCase().includes(`<${t}>`) || label.toLowerCase() === t);
  const wanted = words(t);
  if (wanted.length === 0) return false;
  return labels.some((label) => {
    const have = new Set(words(label));
    return wanted.every((w) => have.has(w));
  });
}

/** Does a document the user named ("the Q3 report") match a title or path? At least half its words, and one. */
export function documentMatches(named: string, labels: readonly string[]): boolean {
  const wanted = words(named).filter((w) => w.length >= 3 || /\d/.test(w));
  if (wanted.length === 0) return false;
  return labels.some((label) => {
    const have = words(label);
    const hits = wanted.filter((w) => have.some((h) => h === w || h.startsWith(w) || w.startsWith(h))).length;
    return hits >= Math.max(1, Math.ceil(wanted.length / 2));
  });
}

/**
 * Why the plan doesn't cover this write, or null when it does. A mail's every recipient must be a planned target
 * of a planned send_mail; a share's recipient and document must both be in one planned share_document.
 */
export function uncovered(plan: Plan, call: ToolCall): string | null {
  const planned = plan.writes.filter((w) => w.tool === call.tool);
  if (planned.length === 0) return `the plan has no ${call.tool}.`;
  if (call.tool === "remember") return null;

  const recipients = call.screen?.recipients ?? [];
  if (call.tool === "send_mail") {
    const to = (call.input as { to?: unknown }).to;
    const addresses = Array.isArray(to) ? to.map(String) : [];
    for (const address of addresses) {
      const labels = recipients.filter((r) => r.toLowerCase().includes(`<${address.toLowerCase()}>`));
      const ok = planned.some((w) => w.targets.some((t) => targetMatches(t, labels.length ? labels : [address])));
      if (!ok) return `the plan doesn't name ${address} as a recipient.`;
    }
    return null;
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
