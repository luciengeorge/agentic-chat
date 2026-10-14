/**
 * Starting and waking the Workflow runner from the app's routes (`AGENT_RUNNER=workflow`). Workflow-first: the
 * run's row is written by the request, then the workflow starts, and its first step binds itself to the row. A
 * hook token routes; it doesn't authorise, so every caller here has already checked the viewer owns the run.
 */
import { sql } from "drizzle-orm";
import { getRun, resumeHook, start } from "workflow/api";
import { HookNotFoundError, WorkflowRunNotFoundError } from "workflow/errors";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { withTenantOn } from "@/db/tenant";
import { cancelRun, loadRun, type RunWaker } from "@/lib/agent-runs";
import { createLogger } from "@/lib/logger";

import type { TokenChunk } from "./agent-run-steps";

import { agentRunWorkflow, approvalToken, type RunSignal, runToken } from "./agent-run";
import { doneToken, type RunDone } from "./orchestrator-steps";

const logger = createLogger("workflows.agent-run");

const FINAL_WORKFLOW = new Set(["completed", "failed", "cancelled"]);
const RESUME_TRIES = 15;
const RESUME_WAIT_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resumes a hook, waiting a moment for one that isn't registered yet (`start()` returns before the run has made
 * its hooks). False if it never appeared. */
async function resume(token: string, payload: unknown, tries = RESUME_TRIES): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await resumeHook(token, payload);
      return true;
    } catch (error) {
      if (!HookNotFoundError.is(error)) throw error;
      if (attempt >= tries) return false;
      await sleep(RESUME_WAIT_MS);
    }
  }
}

export type KickAction = "start" | "wake" | "reconcile" | "replace" | "leave";

/**
 * What a kick does, from the run's workflow id and that workflow's status (`gone`: Workflow has no such run; null:
 * the status couldn't be read). Only a workflow that has surely ended is replaced: two live workflows driving one
 * run would each send its writes under their own step keys, so a write could go out twice.
 * - no workflow yet: start one;
 * - running or pending: wake it (a missing hook means it hasn't made it yet, and it reads the log once it has);
 * - cancelled outside the app: cancel the run to match;
 * - completed, failed or gone: replace it;
 * - status unknown: leave it, and let the next kick try again.
 */
export function kickAction(workflowRunId: string | null, status: string | null): KickAction {
  if (!workflowRunId) return "start";
  if (status === null) return "leave";
  if (status === "cancelled") return "reconcile";
  if (status === "gone" || FINAL_WORKFLOW.has(status)) return "replace";
  return "wake";
}

/** The workflow's status, `gone` if Workflow has no such run, or null if it couldn't be read. */
async function workflowStatus(workflowRunId: string): Promise<string | null> {
  try {
    return await getRun(workflowRunId).status;
  } catch (error) {
    if (WorkflowRunNotFoundError.is(error)) return "gone";
    logger.warn("couldn't read the workflow's status; the next kick tries again", { workflowRunId, error });
    return null;
  }
}

/**
 * Starts a workflow for the run, unless one is driving it; then wakes that one instead. Idempotent: a live
 * workflow just wakes, and two starts at once bind one workflow (`bindRun`), the other returning `duplicate`. A
 * workflow that has ended while the run still has work is replaced. One cancelled outside the app (the Workflow
 * CLI, `ex start`) isn't: the run is cancelled to match.
 */
export async function kickWorkflow(db: Db, viewer: Viewer, runId: string): Promise<void> {
  const run = await withTenantOn(db, viewer.tenantId, (tx) => loadRun(tx, viewer, runId));
  if (!run) return;
  const status = run.workflowRunId ? await workflowStatus(run.workflowRunId) : null;
  const action = kickAction(run.workflowRunId, status);
  if (action === "leave") return;
  if (action === "reconcile") {
    await reconcileCancelled(db, viewer, runId);
    return;
  }
  if (action === "wake") {
    if (!(await resume(runToken(runId), { kind: "wake" } satisfies RunSignal))) {
      logger.warn("run hook not there yet; the workflow reads the log once it makes it", {
        runId,
        workflowRunId: run.workflowRunId,
      });
    }
    return;
  }
  if (action === "replace") {
    const stale = run.workflowRunId;
    await withTenantOn(db, viewer.tenantId, (tx) =>
      tx.execute(sql`UPDATE runs SET workflow_run_id = NULL WHERE id = ${runId} AND workflow_run_id = ${stale}`),
    );
  }
  const started = await start(agentRunWorkflow, [viewer.tenantId, viewer.userId, runId]);
  logger.info("workflow started", { runId, workflowRunId: started.runId });
}

/** Tells the run's workflow what changed: an approval's hook for a decision, the run's hook for a cancel or a
 * message. */
export function workflowWaker(db: Db): RunWaker {
  return async (viewer, runId, wake) => {
    if (wake.kind === "approval") {
      // The decision is committed. A workflow that hasn't made the hook yet reads it from the log before it waits;
      // one that's gone (a crash) is started again.
      if (!(await resume(approvalToken(wake.approvalId), {}, 3))) await kickWorkflow(db, viewer, runId);
      return;
    }
    if (wake.kind === "cancel") {
      const run = await withTenantOn(db, viewer.tenantId, (tx) => loadRun(tx, viewer, runId));
      if (run?.workflowRunId && !(await resume(runToken(runId), { kind: "cancel" } satisfies RunSignal, 3))) {
        // No hook to hear it: stop the workflow outright. The run is already cancelled in Postgres.
        await getRun(run.workflowRunId)
          .cancel({ cancelReason: "cancelled by the user" })
          .catch(() => {});
      }
      return;
    }
    await kickWorkflow(db, viewer, runId);
  };
}

/** The run's tokens from now on: a reader that connects mid-turn gets the rest of that turn, never what it missed
 * (the turn's event has all of it). */
export async function tokenStream(workflowRunId: string): Promise<ReadableStream<TokenChunk>> {
  const run = getRun(workflowRunId);
  const probe = run.getReadable<TokenChunk>();
  const tail = await probe.getTailIndex();
  await probe.cancel();
  return run.getReadable<TokenChunk>({ startIndex: tail + 1 });
}

/**
 * A run whose Workflow run was cancelled outside the app stays `running` or `waiting` in Postgres, since nothing
 * is left to write its end. This cancels it (and its live sub-agents), rejects its pending approvals, and tells
 * whoever waits on it (a parent run, an automation's fan-out). True if it changed anything.
 */
export async function reconcileCancelled(db: Db, viewer: Viewer, runId: string): Promise<boolean> {
  const result = await cancelRun(db, viewer, runId, workflowWaker(db), {
    reason: "cancelled outside the app",
    byUser: false,
  });
  if (result !== "ok") return false;
  await resumeHook(doneToken(runId), { status: "cancelled" } satisfies RunDone).catch(() => {});
  logger.info("run reconciled: its workflow was cancelled outside the app", { runId });
  return true;
}

/**
 * Finds every live run whose Workflow run was cancelled outside the app, across tenants (the owner's pool lists
 * them; each is then cancelled in its own tenant), and reconciles it. Returns the runs it changed.
 */
export async function reconcileCancelledRuns(system: Db, db: Db): Promise<string[]> {
  const rows = await system.execute<{ id: string; tenant_id: string; user_id: string; workflow_run_id: string }>(sql`
    SELECT id, tenant_id, user_id, workflow_run_id FROM runs
    WHERE status IN ('queued', 'running', 'waiting') AND workflow_run_id IS NOT NULL`);
  const changed: string[] = [];
  for (const row of rows) {
    const status = await getRun(row.workflow_run_id).status.catch(() => null);
    if (status !== "cancelled") continue;
    if (await reconcileCancelled(db, { tenantId: row.tenant_id, userId: row.user_id }, row.id)) changed.push(row.id);
  }
  return changed;
}
