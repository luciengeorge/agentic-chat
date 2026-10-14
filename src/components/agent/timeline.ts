import type { RunEvent, RunStatus, ToolCall } from "#learn/agent/types";

/** One row of a run's timeline, folded from its events. */
export type TimelineItem =
  | { kind: "user"; key: string; text: string }
  | { kind: "plan"; key: string; goal: string; steps: string[]; writes: PlannedWrite[] }
  | { kind: "text"; key: string; text: string }
  | { kind: "tool"; key: string; call: ToolCall; result: ToolOutcome | null }
  | {
      kind: "approval";
      key: string;
      approvalId: string;
      call: ToolCall;
      expiresAt: string;
      decision: "approved" | "rejected" | "expired" | null;
    }
  | { kind: "status"; key: string; to: RunStatus; reason?: string }
  | { kind: "error"; key: string; message: string }
  | { kind: "compaction"; key: string };

export interface PlannedWrite {
  tool: string;
  targets: string[];
  documents: string[];
}

export type ToolOutcome = { ok: true; output: unknown } | { ok: false; error: string; refused: boolean };

export const FINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

const PLAN_TOOL = "make_plan";

/** The run's status from its events: the latest status event, else queued. */
export function statusOf(events: readonly RunEvent[]): RunStatus {
  for (let i = events.length - 1; i >= 0; i--) {
    const data = events[i].data;
    if (data.type === "status") return data.to;
  }
  return "queued";
}

/**
 * Folds the event log into rows: each tool call is one row that its result fills in later, each approval one row
 * that its decision fills in. The `queued -> running` start and `waiting -> running` resumes are left out: the
 * rows around them already say it.
 */
export function foldTimeline(events: readonly RunEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: "tool" }>>();
  const approvals = new Map<string, Extract<TimelineItem, { kind: "approval" }>>();

  for (const { seq, data } of events) {
    const key = String(seq);
    switch (data.type) {
      case "user_message":
        items.push({ kind: "user", key, text: data.text });
        break;
      case "assistant_turn":
        if (data.text.trim()) items.push({ kind: "text", key, text: data.text });
        for (const call of data.toolCalls) {
          if (call.tool === PLAN_TOOL) {
            const plan = call.input as Partial<{ goal: string; steps: string[]; writes: PlannedWrite[] }>;
            items.push({
              kind: "plan",
              key: `${key}:${call.callId}`,
              goal: plan.goal ?? "",
              steps: plan.steps ?? [],
              writes: plan.writes ?? [],
            });
            continue;
          }
          const item = { kind: "tool" as const, key: `${key}:${call.callId}`, call, result: null };
          tools.set(call.callId, item);
          items.push(item);
        }
        break;
      case "tool_result": {
        const item = tools.get(data.callId);
        if (!item) break;
        item.result = data.ok
          ? { ok: true, output: data.output }
          : { ok: false, error: data.error, refused: data.error.startsWith("Refused by policy") };
        break;
      }
      case "approval_requested": {
        const item = {
          kind: "approval" as const,
          key,
          approvalId: data.approvalId,
          call: data.call,
          expiresAt: data.expiresAt,
          decision: null,
        };
        approvals.set(data.approvalId, item);
        items.push(item);
        break;
      }
      case "approval_decided": {
        const item = approvals.get(data.approvalId);
        if (item) item.decision = data.decision;
        break;
      }
      case "status":
        if (data.to === "running" || (data.to === "waiting" && data.reason === "approval")) break;
        items.push({ kind: "status", key, to: data.to, reason: data.reason });
        break;
      case "error":
        if (!data.retryable) items.push({ kind: "error", key, message: data.message });
        break;
      case "compaction":
        items.push({ kind: "compaction", key });
        break;
    }
  }
  return items;
}

/** Approvals still waiting on the user. */
export const openApprovals = (items: readonly TimelineItem[]) =>
  items.filter((i): i is Extract<TimelineItem, { kind: "approval" }> => i.kind === "approval" && !i.decision);
