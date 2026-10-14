import type { Viewer } from "#learn/retrieve/types";

import { rememberTool } from "#learn/agent/memory";
import { CHAT_REASONING_EFFORT } from "#learn/model/config";
import { appDb } from "@/db/pool";
import { withTenant } from "@/db/tenant";
import { createRunnerLoop, driveRun } from "@/lib/agent-runs";
import { agentGuard, agentTools } from "@/lib/agent-tools";
import { createLogger } from "@/lib/logger";
import { chatModelFromEnv } from "@/routes/api/chat/-deps";

import type { RunRoutesDeps } from "./-runs";

const logger = createLogger("agent.runner");

/**
 * Runs the run in this server process, after the request that started it has answered. It isn't durable: a
 * restart mid-run leaves it `running` (section 15's runners fix that).
 */
export function kickRun(viewer: Viewer, runId: string): void {
  const loop = createRunnerLoop(viewer, {
    model: chatModelFromEnv(),
    tools: [...agentTools(), rememberTool({ withTenant })],
    reasoningEffort: CHAT_REASONING_EFFORT,
    guard: agentGuard(viewer),
    maxOutputTokens: 2000,
  });
  driveRun({ db: appDb(), loop }, viewer, runId).then(
    (outcome) => logger.info("runner stopped", { runId, outcome }),
    (error: unknown) => logger.error("runner crashed", { runId, error }),
  );
}

export function runRoutesDeps(): RunRoutesDeps {
  return { db: appDb(), kick: kickRun };
}
