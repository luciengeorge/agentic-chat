import type { z } from "zod";

import type { Usage } from "#learn/model/types";
import type { Viewer } from "#learn/retrieve/types";

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
// queued -> running | cancelled
// running -> waiting | succeeded | failed | cancelled | timed_out
// waiting -> running | cancelled | timed_out      (an expired approval resumes the run with "expired")
// succeeded, failed, cancelled, timed_out are final

export interface ToolCall {
  callId: string;
  tool: string;
  input: unknown;
}

export type RunEventData =
  | { type: "user_message"; messageId: string; text: string }
  | { type: "assistant_turn"; text: string; toolCalls: ToolCall[]; usage: Usage }
  | { type: "tool_result"; callId: string; ok: true; output: unknown }
  | { type: "tool_result"; callId: string; ok: false; error: string }
  | { type: "approval_requested"; approvalId: string; call: ToolCall; expiresAt: string }
  | { type: "approval_decided"; approvalId: string; decision: "approved" | "rejected" | "expired"; by: string | null }
  | { type: "status"; from: RunStatus; to: RunStatus; reason?: string }
  | { type: "compaction"; throughSeq: number; summary: string }
  | { type: "error"; message: string; retryable: boolean };

export interface RunEvent {
  runId: string;
  seq: number;
  at: string;
  data: RunEventData;
}

/** What the loop does next, decided from the events alone. */
export type NextAction =
  | { kind: "model" }
  | { kind: "tools"; calls: ToolCall[] } // read tools, or approved write tools
  | { kind: "approval"; call: ToolCall } // a write tool waiting on its user
  | { kind: "wait" } // nothing to do until a message or a decision arrives
  | { kind: "finish"; status: "succeeded" | "failed" | "timed_out"; reason?: string };

export interface ToolContext {
  viewer: Viewer;
  runId: string;
  callId: string;
  /** Stable across retries of this call: derived from the run and the call, never random. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface AgentTool<I = unknown, O = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  effect: "read" | "write";
  /** Write tools say true. A policy (section 17) can still refuse the call before this is asked. */
  needsApproval(input: I, ctx: ToolContext): boolean;
  execute(input: I, ctx: ToolContext): Promise<O>;
}
