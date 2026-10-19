/**
 * The durability lab (section 15, dev only): a real agent run whose send is held by a fake-workspace latency fault,
 * so the learner can kill `pnpm dev` while the mail is in flight, start it again, and watch the run resume and the
 * mail go out once. The page never kills anything; it only reads the run and fake-workspace's mailroom.
 */
import { sql } from "drizzle-orm";

import type { RunEvent } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";
import type { RunWaker } from "@/lib/agent-runs";

import { withTenantOn } from "@/db/tenant";
import { decideApproval, loadState, startRun } from "@/lib/agent-runs";

import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../../servers/fake-workspace/control";
import { addFault, type Workspace } from "./connectors-panel";

/** How long fake-workspace holds the send: time enough to press Ctrl+C. */
export const HOLD_MS = 20_000;
/** Every lab run's first message starts with this, so the page can list them. */
export const LAB_MARK = "[durability lab]";

export interface DurabilityDeps {
  db: Db;
  /** The viewer's site on fake-workspace, and its control token. */
  workspace: Workspace;
  /** Starts the run's runner (the routes' `kick`). */
  kick(viewer: Viewer, runId: string): void;
  /** Tells the runner about a decision (the routes' `wake`). */
  wake: RunWaker;
}

export interface LabMail {
  to: string[];
  subject: string;
  idempotencyKey: string;
  sentAt: string;
}

export interface HeldRunView {
  runId: string;
  status: string;
  version: number;
  workflowRunId: string | null;
  createdAt: string;
  events: Array<{ seq: number; at: string; type: string; summary: string }>;
  /** The send waiting on the viewer, if any. */
  approval: { approvalId: string; tool: string } | null;
  /** When the send was approved, if it was. */
  approvedAt: string | null;
  /** fake-workspace's mails whose key is this run's: `agent:<runId>:...`. */
  mails: LabMail[];
  /** The server's time when it read all this. */
  readAt: string;
}

/** Starts a real agent run (the app's model) that asks to send the viewer one mail and nothing else. */
export async function startHeldRun(deps: DurabilityDeps, viewer: Viewer, email: string): Promise<{ runId: string }> {
  const runId = crypto.randomUUID();
  const text =
    `${LAB_MARK} Send one email to ${email} with the subject "Durability lab ${runId.slice(0, 8)}" and the body ` +
    `"Checking that a send survives a restart." Don't search for anything first; just send that one email.`;
  await startRun(deps.db, viewer, { runId, message: { messageId: `lab-durability-${runId}`, text } });
  deps.kick(viewer, runId);
  return { runId };
}

/**
 * Approves the run's waiting send, after adding a latency fault that holds the next send on the viewer's site for
 * HOLD_MS (the viewer's own sends only). The decision goes through `decideApproval`, as the inbox's does.
 */
export async function approveHeld(
  deps: DurabilityDeps,
  viewer: Viewer,
  runId: string,
): Promise<"ok" | "not-found" | "not-pending"> {
  const view = await heldRun(deps, viewer, runId);
  if (!view) return "not-found";
  if (!view.approval) return "not-pending";
  await addFault(deps.workspace, {
    kind: "latency",
    latency_ms: HOLD_MS,
    path_prefix: `/v1.0/users/${viewer.userId}/sendMail`,
    count: 1,
  });
  return decideApproval(deps.db, viewer, view.approval.approvalId, "approved", deps.wake);
}

function summary(event: RunEvent): string {
  const { data } = event;
  switch (data.type) {
    case "status":
      return `${data.from} -> ${data.to}${data.reason ? ` (${data.reason})` : ""}`;
    case "assistant_turn":
      return data.toolCalls.length > 0 ? data.toolCalls.map((c) => c.tool).join(", ") : data.text.slice(0, 120);
    case "tool_result":
      return data.ok ? `${data.callId}: ok` : `${data.callId}: ${data.error}`;
    case "approval_requested":
      return `${data.call.tool}, due ${data.expiresAt}`;
    case "approval_decided":
      return data.decision;
    case "user_message":
      return data.text.slice(0, 120);
    case "error":
      return data.message;
    case "compaction":
      return `through seq ${data.throughSeq}`;
  }
}

async function mailsOf(workspace: Workspace, runId: string): Promise<LabMail[]> {
  const response = await (workspace.fetch ?? fetch)(`${workspace.baseUrl.replace(/\/$/, "")}/_control/mail`, {
    headers: { [CONTROL_HEADER]: workspace.controlToken ?? DEV_CONTROL_TOKEN },
  });
  if (!response.ok) throw new Error(`fake-workspace answered ${response.status} to GET /_control/mail`);
  const { value } = (await response.json()) as {
    value: Array<{ to: string[]; subject: string; idempotencyKey: string | null; sentAt: string }>;
  };
  return value.flatMap((mail) =>
    mail.idempotencyKey?.startsWith(`agent:${runId}:`)
      ? [{ to: mail.to, subject: mail.subject, idempotencyKey: mail.idempotencyKey, sentAt: mail.sentAt }]
      : [],
  );
}

/** The run as the page shows it, or null when it isn't the viewer's. */
export async function heldRun(deps: DurabilityDeps, viewer: Viewer, runId: string): Promise<HeldRunView | null> {
  const state = await withTenantOn(deps.db, viewer.tenantId, (tx) => loadState(tx, viewer, runId));
  if (!state) return null;
  const { run, events } = state;
  const decided = new Set(events.flatMap((e) => (e.data.type === "approval_decided" ? [e.data.approvalId] : [])));
  const open = events.find((e) => e.data.type === "approval_requested" && !decided.has(e.data.approvalId));
  const approved = events.find((e) => e.data.type === "approval_decided" && e.data.decision === "approved");
  return {
    runId,
    status: run.status,
    version: run.version,
    workflowRunId: run.workflowRunId,
    createdAt: new Date(run.createdAt).toISOString(),
    events: events.map((e) => ({ seq: e.seq, at: e.at, type: e.data.type, summary: summary(e) })),
    approval:
      open?.data.type === "approval_requested" ? { approvalId: open.data.approvalId, tool: open.data.call.tool } : null,
    approvedAt: approved?.at ?? null,
    mails: await mailsOf(deps.workspace, runId),
    readAt: new Date().toISOString(),
  };
}

/** The viewer's lab runs, newest first. */
export async function listHeldRuns(
  db: Db,
  viewer: Viewer,
): Promise<Array<{ id: string; status: string; createdAt: string }>> {
  const rows = await withTenantOn(db, viewer.tenantId, (tx) =>
    tx.execute<{ id: string; status: string; created_at: Date | string }>(sql`
      SELECT r.id, r.status, r.created_at FROM runs r
      WHERE r.user_id = ${viewer.userId}
        AND EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = r.id AND e.seq = 1
                    AND e.data->>'text' LIKE ${`${LAB_MARK}%`})
      ORDER BY r.created_at DESC
      LIMIT 10`),
  );
  return rows.map((r) => ({ id: r.id, status: r.status, createdAt: new Date(r.created_at).toISOString() }));
}
