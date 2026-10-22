import { definePlugin } from "nitro";

import { appDb, systemDb } from "@/db/pool";
import { agentRunner } from "@/lib/agent-runtime";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { pollLoop } from "@/lib/poll-loop";
import { reconcileCancelledRuns } from "@/workflows/agent-run-start";
import { tickSchedules } from "@/workflows/automation-start";

const logger = createLogger("automations.scheduler");

const TICK_MS = 30_000;
const LOOP = Symbol.for("agentic-chat.scheduler-loop");

/**
 * The automation scheduler, as a loop in the dev server (section 16.4; on Vercel a cron route does it, section
 * 22). Every tick it starts each schedule slot that's due. A slot fires once however many schedulers see it, or
 * however often one restarts: the fire's workflow claims it by its key first.
 *
 * The same tick reconciles runs whose workflow was cancelled outside the app (the Workflow CLI, `ex start`), which
 * would otherwise stay live forever. Both cross tenants, so they read on the owner's pool.
 */
function startLoop(): () => void {
  async function tick() {
    await tickSchedules(systemDb());
    const reconciled = await reconcileCancelledRuns(systemDb(), appDb());
    if (reconciled.length) logger.info("runs reconciled", { runs: reconciled });
  }
  // The tick is already the backoff's cap: while Postgres is down it keeps its pace and logs once.
  return pollLoop({ name: "scheduler", intervalMs: TICK_MS, maxMs: TICK_MS, firstMs: 5_000, pass: tick, logger }).stop;
}

export default definePlugin(() => {
  if (acEnv() !== "dev" || agentRunner() !== "workflow") return;
  // A reload runs plugins again: one loop per process.
  const store = globalThis as typeof globalThis & { [LOOP]?: () => void };
  store[LOOP]?.();
  store[LOOP] = startLoop();
  logger.info("scheduler started", { tickMs: TICK_MS });
});
