import { start } from "workflow/api";

import { fanOut } from "#learn/agent/fanout";

import { agentRunWorkflow } from "./agent-run";
import { admitStep, claimFireStep, createRunStep } from "./automation-steps";
import { doneToken, runDone } from "./orchestrator-steps";

/** Runs of one fire going at once, at most. */
export const AUTOMATION_CONCURRENCY = 3;

/**
 * One fire of an automation (section 16.4): claim it, then one agent run per item, as the owner, fanned out with
 * backpressure (section 16.5): at most `limit` runs at once, the rest waiting their turn, and each start asks the
 * kill switch and the owner's budget first. Each run is the ordinary agent workflow, started as a child workflow;
 * this one waits on the hook the run resumes when it ends.
 *
 * Anyone may start this for a fire (two schedulers, ingest twice): only the first claim does the work.
 */
export async function automationWorkflow(
  tenantId: string,
  automationId: string,
  fireKey: string,
  firedAt: string,
  documentIds: string[] | null,
  limit: number = AUTOMATION_CONCURRENCY,
) {
  "use workflow";

  const claim = await claimFireStep(tenantId, automationId, fireKey, firedAt, documentIds);
  if (claim.kind !== "fire") return { status: claim.kind, runs: [] };

  const results = await fanOut(claim.items, {
    limit,
    admit: () => admitStep(tenantId, claim.ownerId),
    run: async (item) => {
      const runId = await createRunStep(tenantId, automationId, fireKey, claim.ownerId, claim.prompt, item);
      using done = runDone.create({ token: doneToken(runId) });
      await start(agentRunWorkflow, [tenantId, claim.ownerId, runId]);
      const { status } = await done;
      return { runId, status };
    },
  });
  return { status: "fired" as const, runs: results };
}
