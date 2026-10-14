import { definePlugin } from "nitro";

import { systemDb } from "@/db/pool";
import { startAgentWorkers } from "@/lib/agent-queue";
import { agentRunner } from "@/lib/agent-runtime";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

const logger = createLogger("agent.queue");
const WORKERS = Symbol.for("agentic-chat.agent-workers");

/**
 * The queue runner's workers (`AGENT_RUNNER=queue`), in the dev server. They claim across tenants, so they use the
 * owner's pool. Off for the other runners.
 */
export default definePlugin(() => {
  if (acEnv() !== "dev" || agentRunner() !== "queue") return;
  // A reload runs plugins again: one set of workers per process.
  const store = globalThis as typeof globalThis & { [WORKERS]?: AbortController };
  store[WORKERS]?.abort();
  const stop = new AbortController();
  store[WORKERS] = stop;
  void startAgentWorkers(systemDb(), stop.signal).catch((error: unknown) =>
    logger.error("agent workers stopped", { error }),
  );
  logger.info("agent workers started");
});
