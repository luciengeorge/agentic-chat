/**
 * The agent run's steps (section 15.3). Each model turn and each tool call is a step. Events are appended with
 * `step_key` from the `stepId`, so a step that runs again after a crash or a retry finds its events already
 * written and writes nothing twice; a write tool's idempotency key comes from the same `stepId`, so the other side
 * does it once. Steps fetch what they need from `agentRuntime()`: arguments carry ids only.
 */
import { sql } from "drizzle-orm";
import { FatalError, getStepMetadata, getWritable, RetryableError } from "workflow";

import type { ToolOutcome } from "#learn/agent/durable-run";
import type { ToolCall } from "#learn/agent/types";
import type { Viewer } from "#learn/retrieve/types";

import { failRun, isFinalStatus, modelStep, type Plan, plan, recordResults } from "#learn/agent/checkpoint";
import { stepIdempotencyKey, turnFailure } from "#learn/agent/durable";
import { RunHalted } from "#learn/agent/loop";
import { withTenantOn } from "@/db/tenant";
import { expireApproval, loadRun, runStore, stepLoop } from "@/lib/agent-runs";
import { agentRuntime, STEP_TIMEOUT_MS } from "@/lib/agent-runtime";
import { createLogger } from "@/lib/logger";

const logger = createLogger("workflows.agent-run");

/** Which run a step works on, and as whom. */
export interface RunRef {
  tenantId: string;
  userId: string;
  runId: string;
}

/** A token on the run's stream: text as the model writes it. `turn` is the step writing it, so the stream route
 * can drop tokens of a turn whose event it has already sent. */
export interface TokenChunk {
  delta: string;
  turn: string;
}

type ToolResult = Awaited<ReturnType<ReturnType<typeof stepLoop>["runTools"]>>[number];

export type { ToolOutcome };

const viewerOf = (ref: RunRef): Viewer => ({ tenantId: ref.tenantId, userId: ref.userId });
const stepKey = () => `wf:${getStepMetadata().stepId}`;
const store = (ref: RunRef) =>
  runStore(agentRuntime().db, viewerOf(ref), ref.runId, { approvalTtlMs: agentRuntime().approvalTtlMs });

async function boundLoop(ref: RunRef) {
  const { db, loop } = agentRuntime();
  const viewer = viewerOf(ref);
  const run = await withTenantOn(db, ref.tenantId, (tx) => loadRun(tx, viewer, ref.runId));
  return run && { run, runnerLoop: loop(viewer), loop: stepLoop(loop(viewer), viewer, run) };
}

/** Claims the run for this workflow run: a second start of the same run (two kicks at once) finds it taken. */
export async function bindRun(ref: RunRef, workflowRunId: string): Promise<boolean> {
  "use step";
  const rows = await withTenantOn(agentRuntime().db, ref.tenantId, (tx) =>
    tx.execute(sql`
      UPDATE runs SET workflow_run_id = ${workflowRunId}, updated_at = now()
      WHERE id = ${ref.runId} AND user_id = ${ref.userId}
        AND (workflow_run_id IS NULL OR workflow_run_id = ${workflowRunId})
      RETURNING id`),
  );
  return rows.length > 0;
}

/** Reads the log and decides; makes the status-only moves (claim, wait, finish) itself. */
export async function planStep(ref: RunRef): Promise<Plan> {
  "use step";
  const bound = await boundLoop(ref);
  if (!bound) return { kind: "not-found" };
  return plan(store(ref), bound.loop);
}

/**
 * One model turn (or a compaction), streaming its text to the run's stream. A cancel aborts it through `signal`.
 * Rate limits, 5xx answers, dropped connections and the step's own timeout are retried by Workflow after
 * `retryAfterMs`; anything else fails the run.
 */
export async function modelTurnStep(ref: RunRef, version: number, signal: AbortSignal): Promise<"done" | "stale"> {
  "use step";
  const key = stepKey();
  const { stepTimeoutMs, retryAfterMs } = agentRuntime();
  const bound = await boundLoop(ref);
  if (!bound || isFinalStatus(bound.run.status)) return "done";
  const timeout = AbortSignal.timeout(stepTimeoutMs ?? STEP_TIMEOUT_MS);
  const writer = getWritable<TokenChunk>().getWriter();
  const writes: Promise<void>[] = [];
  try {
    return await modelStep(store(ref), bound.loop, {
      version,
      stepKey: key,
      signal: AbortSignal.any([signal, timeout]),
      onTextDelta: (delta) => writes.push(writer.write({ delta, turn: key })),
    });
  } catch (error) {
    const { attempt } = getStepMetadata();
    const failure = turnFailure(error, { cancelled: signal.aborted, timedOut: timeout.aborted, attempt, retryAfterMs });
    if (failure.kind === "cancelled") throw error;
    if (failure.kind === "halted") {
      await failRun(store(ref), failure.reason, { stepKey: key });
      return "done";
    }
    if (failure.kind === "retry") {
      logger.warn("model turn failed; Workflow will retry it", { runId: ref.runId, attempt, error });
      throw new RetryableError(failure.message, { retryAfter: failure.afterMs });
    }
    throw new FatalError(failure.message);
  } finally {
    await Promise.allSettled(writes);
    writer.releaseLock();
  }
}
modelTurnStep.maxRetries = 3;

/**
 * One tool call, as the run's user, with the step's own idempotency key. A tool's failure comes back as an
 * `ok: false` result for the model; a halted run (the kill switch) comes back as `halted`.
 */
export async function toolStep(ref: RunRef, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
  "use step";
  const { stepId } = getStepMetadata();
  const bound = await boundLoop(ref);
  if (!bound || isFinalStatus(bound.run.status)) return { kind: "skipped" };
  try {
    const [result] = await bound.runnerLoop.runTools([call], {
      viewer: viewerOf(ref),
      run: bound.run,
      signal,
      idempotencyKey: stepIdempotencyKey(ref.runId, stepId),
    });
    return { kind: "result", result };
  } catch (error) {
    if (error instanceof RunHalted) return { kind: "halted", reason: error.reason };
    throw error;
  }
}
toolStep.maxRetries = 3;

/** Appends a turn's results, in call order, once. */
export async function recordStep(ref: RunRef, results: ToolResult[]): Promise<void> {
  "use step";
  await recordResults(store(ref), results, { stepKey: stepKey() });
}

/** Records the approval request and moves the run to waiting. Null when the log moved first. */
export async function approvalStep(ref: RunRef, call: ToolCall, version: number) {
  "use step";
  return store(ref).requestApproval(call, version, { stepKey: stepKey() });
}

/** The approval's time ran out: settle it as expired (unless the user got there first). */
export async function expireStep(ref: RunRef, approvalId: string): Promise<boolean> {
  "use step";
  return withTenantOn(agentRuntime().db, ref.tenantId, (tx) => expireApproval(tx, approvalId, { timerFired: true }));
}

/** Ends the run `failed` with the reason. */
export async function failStep(ref: RunRef, reason: string): Promise<void> {
  "use step";
  await failRun(store(ref), reason, { stepKey: stepKey() });
}

/** Ends the token stream: the run is over, so readers can stop. */
export async function closeTokens(): Promise<void> {
  "use step";
  await getWritable<TokenChunk>().close();
}
