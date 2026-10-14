/**
 * Starting automation fires from the app: the scheduler's tick and the "Run now" button. Starting a fire twice is
 * harmless: the workflow's first step claims it, once.
 */
import { start } from "workflow/api";

import type { Db } from "@/db/create";

import { dueScheduleFires, type DueFire } from "@/lib/automations";
import { createLogger } from "@/lib/logger";

import { automationWorkflow } from "./automation";

const logger = createLogger("automations.scheduler");

export async function startFire(fire: DueFire, documentIds: string[] | null = null): Promise<string> {
  const run = await start(automationWorkflow, [
    fire.tenantId,
    fire.automationId,
    fire.fireKey,
    fire.firedAt.toISOString(),
    documentIds,
  ]);
  return run.runId;
}

/** One scheduler tick: every schedule slot due now and not yet claimed gets its workflow. */
export async function tickSchedules(system: Db, now = new Date()): Promise<DueFire[]> {
  const due = await dueScheduleFires(system, now);
  for (const fire of due) {
    try {
      await startFire(fire);
      logger.info("schedule fired", { automationId: fire.automationId, fireKey: fire.fireKey });
    } catch (error) {
      logger.error("starting a fire failed; the next tick tries again", { automationId: fire.automationId, error });
    }
  }
  return due;
}
