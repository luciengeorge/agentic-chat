/**
 * Starting and waking the Workflow runner from the app's routes (`AGENT_RUNNER=workflow`). Workflow-first: the
 * run's row is written by the request, then the workflow starts, and its first step binds itself to the row. A
 * hook token routes; it doesn't authorise, so every caller here has already checked the viewer owns the run.
 */
import { sql } from "drizzle-orm";
import { getRun, resumeHook, start } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";

import type { Viewer } from "#learn/retrieve/types";
import type { Db } from "@/db/create";

import { withTenantOn } from "@/db/tenant";
import { loadRun, type RunWaker } from "@/lib/agent-runs";
import { createLogger } from "@/lib/logger";

import type { TokenChunk } from "./agent-run-steps";

import { agentRunWorkflow, approvalToken, type RunSignal, runToken } from "./agent-run";

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

/** Starts a workflow for the run, unless one is driving it; then wakes that one instead. A workflow that ended
 * while the run still has work (it crashed, or someone cancelled it in Workflow) is replaced. */
export async function kickWorkflow(db: Db, viewer: Viewer, runId: string): Promise<void> {
  const run = await withTenantOn(db, viewer.tenantId, (tx) => loadRun(tx, viewer, runId));
  if (!run) return;
  if (run.workflowRunId) {
    const status = await getRun(run.workflowRunId).status.catch(() => "failed");
    if (!FINAL_WORKFLOW.has(status)) {
      if (await resume(runToken(runId), { kind: "wake" } satisfies RunSignal)) return;
      logger.warn("run hook never appeared; starting the run again", { runId, workflowRunId: run.workflowRunId });
    }
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
