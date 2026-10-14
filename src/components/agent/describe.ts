import type { ToolCall } from "#learn/agent/types";

import type { ToolOutcome } from "./timeline";

type Input = Record<string, unknown>;
const inputOf = (call: ToolCall): Input => (call.input && typeof call.input === "object" ? (call.input as Input) : {});
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);
const quoted = (value: unknown) => (typeof value === "string" && value ? `“${value}”` : "");

/** One line saying what a call does, in words, for the timeline. */
export function callSummary(call: ToolCall): string {
  const input = inputOf(call);
  switch (call.tool) {
    case "search_documents":
      return `Searched for ${quoted(input.query)}`;
    case "read_document":
      return "Read a document";
    case "find_person":
      return `Looked up ${quoted(input.query)}`;
    case "send_mail":
      return `Email to ${list(input.to).join(", ") || "nobody"}`;
    case "share_document":
      return "Share a document";
    case "remember":
      return `Remember ${quoted(input.note)}`;
    default:
      return call.tool;
  }
}

/** What came back, in a few words. */
export function outcomeSummary(call: ToolCall, outcome: ToolOutcome): string {
  if (!outcome.ok) return outcome.error;
  const output = (outcome.output ?? {}) as Input;
  switch (call.tool) {
    case "search_documents": {
      const n = list(output.passages).length;
      return `${n} ${n === 1 ? "passage" : "passages"}`;
    }
    case "read_document":
      return typeof output.title === "string" ? output.title : "Read";
    case "find_person": {
      const n = list(output.people).length;
      return n === 0 ? "Nobody found" : `${n} found`;
    }
    case "send_mail":
      return "Sent";
    case "share_document":
      return typeof output.recipient === "string" ? `Shared with ${output.recipient}` : "Shared";
    case "remember":
      return "Saved";
    default:
      return "Done";
  }
}

/** The fields of a write the user approves, as label and value. */
export function writeFields(call: ToolCall): Array<{ label: string; value: string; long?: boolean }> {
  const input = inputOf(call);
  if (call.tool === "send_mail") {
    const attachments = list(input.attachmentDocumentIds);
    return [
      { label: "To", value: list(input.to).join(", ") },
      { label: "Subject", value: String(input.subject ?? "") },
      { label: "Body", value: String(input.body ?? ""), long: true },
      ...(attachments.length
        ? [{ label: "Attachments", value: (call.screen?.documents ?? attachments).join(", ") }]
        : []),
    ];
  }
  if (call.tool === "share_document") {
    return [
      { label: "Document", value: call.screen?.documents?.join(", ") ?? String(input.documentId ?? "") },
      { label: "With", value: call.screen?.recipients?.join(", ") ?? String(input.recipientId ?? "") },
      { label: "Access", value: String(input.role ?? "read") },
    ];
  }
  return Object.entries(input).map(([label, value]) => ({
    label,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

export const approvalTitle = (call: ToolCall) =>
  call.tool === "send_mail"
    ? "Send this email?"
    : call.tool === "share_document"
      ? "Share this document?"
      : `Run ${call.tool}?`;
