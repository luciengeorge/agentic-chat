import type { Viewer } from "#learn/retrieve/types";

import { appDb } from "@/db/pool";
import { kickQueued } from "@/lib/agent-queue";
import { abortLive, driveRun, holdLive, type RunWaker } from "@/lib/agent-runs";
import { agentRunner, agentRuntime } from "@/lib/agent-runtime";
import { createLogger } from "@/lib/logger";
import { kickWorkflow, tokenStream, workflowWaker } from "@/workflows/agent-run-start";

import type { RunRoutesDeps } from "./-runs";

const logger = createLogger("agent.runner");

/**
 * The in-request runner: runs the run in this server process, after the request that started it has answered.
 * It isn't durable: a restart mid-run leaves it `running`. `AGENT_RUNNER=inline` only.
 */
export function kickRun(viewer: Viewer, runId: string): void {
  const { db, loop } = agentRuntime();
  const live = holdLive(runId);
  driveRun({ db, loop: loop(viewer) }, viewer, runId, live.signal)
    .then(
      (outcome) => logger.info("runner stopped", { runId, outcome }),
      (error: unknown) => logger.error("runner crashed", { runId, error }),
    )
    .finally(live.release);
}

/** A cancel aborts this process's work on the run; anything else starts the runner if the run has work. */
export const wakeInline: RunWaker = async (viewer, runId, wake) => {
  if (wake.kind === "cancel") abortLive(runId);
  else kickRun(viewer, runId);
};

/** The queue runner: anything but a cancel queues the run's next checkpoint. A cancel aborts the job in flight
 * when it runs in this process; elsewhere, its next checkpoint finds the run final. */
const wakeQueued: RunWaker = async (viewer, runId, wake) => {
  if (wake.kind === "cancel") abortLive(runId);
  else await kickQueued(appDb(), viewer, runId);
};

const background = (what: string, runId: string, work: Promise<unknown>) =>
  void work.catch((error: unknown) => logger.error(`${what} failed`, { runId, error }));

/** The routes' runner, picked by `AGENT_RUNNER` (workflow by default). Kicks run after the answer. */
export function runRoutesDeps(): RunRoutesDeps {
  const db = appDb();
  const runner = agentRunner();
  if (runner === "inline") return { db, kick: kickRun, wake: wakeInline };
  if (runner === "queue") {
    return {
      db,
      kick: (viewer, runId) => background("queue kick", runId, kickQueued(db, viewer, runId)),
      wake: wakeQueued,
    };
  }
  return {
    db,
    kick: (viewer, runId) => background("workflow kick", runId, kickWorkflow(db, viewer, runId)),
    wake: workflowWaker(db),
    tokens: tokenStream,
  };
}
