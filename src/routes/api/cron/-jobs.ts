/** The cron routes' passes, bound to the app's pools and code. Server only. */
import { workOnce } from "#learn/queue/worker";
import { appDb, systemDb } from "@/db/pool";
import { AGENT_QUEUE, type AgentJob, agentJobHandler, agentRetryInMs } from "@/lib/agent-queue";
import { agentRunner } from "@/lib/agent-runtime";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { processConversationLogPass } from "@/lib/observability.server";
import { deliver } from "@/server/plugins/relay-deliver";
import { reconcileCancelledRuns } from "@/workflows/agent-run-start";
import { tickSchedules } from "@/workflows/automation-start";

import { type CronPass, queuePass, relayPass, schedulerPass, syncPass } from "./-cron";

const logger = createLogger("cron");

/** Outside prod the stand-in drive has a default address; in prod a sync needs one set. */
const workspaceConfigured = () => acEnv() !== "prod" || !!process.env.FAKE_WORKSPACE_URL?.trim();

export const CRON_JOBS = {
  relay: () => relayPass(systemDb(), deliver, { conversationLog: processConversationLogPass() }),
  sync: () => syncPass(systemDb(), appDb(), workspaceConfigured()),
  scheduler: () =>
    schedulerPass(
      agentRunner() === "workflow",
      () => tickSchedules(systemDb()),
      () => reconcileCancelledRuns(systemDb(), appDb()),
    ),
  "agent-queue": () =>
    queuePass(agentRunner() === "queue", () =>
      workOnce<AgentJob>({
        db: systemDb(),
        queue: AGENT_QUEUE,
        handler: agentJobHandler(),
        retryInMs: agentRetryInMs(),
        onError: (error, job) => logger.error("agent job failed", { error, jobId: job?.id }),
      }),
    ),
} satisfies Record<string, CronPass>;

export type CronJob = keyof typeof CRON_JOBS;
