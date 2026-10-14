import { z } from "zod";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { decideApproval, listApprovals, type RunWaker } from "@/lib/agent-runs";

export interface ApprovalRoutesDeps {
  db: Db;
  /** Tells the runner holding the run that it was decided. */
  wake?: RunWaker;
}

const MAX_BODY_BYTES = 1024;

export const DecisionSchema = z.object({ decision: z.enum(["approved", "rejected"]) });

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store" } });

/** `GET /api/approvals?status=pending`: the viewer's approvals, newest first; `pending` keeps the open ones. */
export async function handleListApprovals(request: Request, viewer: Viewer, deps: ApprovalRoutesDeps) {
  const status = new URL(request.url).searchParams.get("status");
  if (status !== null && status !== "pending") return json(400, { error: "invalid_request" });
  return json(200, { approvals: await listApprovals(deps.db, viewer, status ?? undefined) });
}

/** `POST /api/approvals/:id` with `{ decision }`: the acting user approves or rejects their run's write action. */
export async function handleDecideApproval(
  request: Request,
  viewer: Viewer,
  approvalId: string,
  deps: ApprovalRoutesDeps,
): Promise<Response> {
  if (!z.uuid().safeParse(approvalId).success) return json(404, { error: "not_found" });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = DecisionSchema.safeParse(body);
  if (!parsed.success) return json(400, { error: "invalid_request" });
  const result = await decideApproval(deps.db, viewer, approvalId, parsed.data.decision, deps.wake);
  if (result === "not-found") return json(404, { error: "not_found" });
  if (result === "not-pending") return json(409, { error: "not_pending" });
  return json(200, { id: approvalId, decision: parsed.data.decision });
}
