import type { Screen } from "#learn/agent/types";

import type { Decision } from "./approval-card";

/** The run and approval routes' error bodies, as a sentence. */
async function failure(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; retryAfterSeconds?: number };
  const messages: Record<string, string> = {
    rate_limited: `You're starting runs faster than the limit allows. Try again in ${body.retryAfterSeconds ?? "a few"} seconds.`,
    not_pending: "That approval was already decided, or it expired.",
    run_finished: "That run has already finished.",
    not_found: "That run isn't yours, or it no longer exists.",
    not_in_directory: "Your account isn't in the company directory yet.",
    disabled: "That automation is turned off.",
  };
  return new Error(messages[body.error ?? ""] ?? `Something went wrong (HTTP ${response.status}). Try again.`);
}

async function post(url: string, body?: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response);
  return response.json();
}

export const startRun = (run: { id: string; conversationId: string; message: { id: string; text: string } }) =>
  post("/api/runs", run);

export type Routed =
  | { route: "answer"; reason: string }
  | { route: "agent"; reason: string; followUp: boolean; id: string; seq: number; duplicate: boolean };

/** Where a chat message goes: a cited answer, a new agent run, or the conversation's live run. `agent` skips the
 * router. */
export const routeMessage = (body: {
  conversationId: string;
  runId: string;
  message: { id: string; text: string };
  agent: boolean;
}) => post("/api/chat/router", body) as Promise<Routed>;

export const decideApproval = (approvalId: string, decision: Decision) =>
  post(`/api/approvals/${approvalId}`, { decision });

export const cancelRun = (runId: string) => post(`/api/runs/${runId}/cancel`);

export interface ApprovalRow {
  id: string;
  runId: string;
  conversationId: string | null;
  callId: string;
  tool: string;
  input: unknown;
  status: "pending" | "approved" | "rejected" | "expired";
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  /** The guardrails' findings, from the run's `approval_requested` event. */
  screen?: Screen | null;
}

export async function pendingApprovals(): Promise<ApprovalRow[]> {
  const response = await fetch("/api/approvals?status=pending");
  if (!response.ok) throw await failure(response);
  return ((await response.json()) as { approvals: ApprovalRow[] }).approvals;
}
