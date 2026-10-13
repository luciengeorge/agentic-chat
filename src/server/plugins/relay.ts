import { definePlugin } from "nitro";

import { onRelayKick, relayOnce } from "@/db/outbox";
import { systemDb } from "@/db/pool";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";

import { deliver } from "./relay-deliver";

const logger = createLogger("relay");

const POLL_MS = 2_000;
const BATCH = 20;
const LOOP = Symbol.for("agentic-chat.relay-loop");

/**
 * The outbox relay, as a loop in the dev server: it drains the outbox on every kick (a request that wrote a row
 * kicks it after commit) and every two seconds as the safety net. It crosses tenants, so it runs on the owner's
 * pool. On Vercel this becomes a cron route (section 22).
 */
function startLoop(): () => void {
  let running = false;
  let again = false;
  let stopped = false;

  async function drain() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        const result = await relayOnce(systemDb(), deliver, { batchSize: BATCH });
        const { published, retried, failed, outage } = result;
        if (published.length || retried.length || failed.length || outage) {
          logger.info("relay pass", { published: published.length, retried, failed, outage });
        }
        if (published.length === BATCH) again = true;
      } while (again && !stopped);
    } catch (error) {
      logger.error("relay pass failed", { error });
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void drain(), POLL_MS);
  const off = onRelayKick(() => void drain());
  void drain();
  return () => {
    stopped = true;
    clearInterval(timer);
    off();
  };
}

export default definePlugin(() => {
  if (acEnv() !== "dev") return;
  // A reload runs plugins again: one loop per process.
  const store = globalThis as typeof globalThis & { [LOOP]?: () => void };
  store[LOOP]?.();
  store[LOOP] = startLoop();
  logger.info("relay started", { pollMs: POLL_MS });
});
