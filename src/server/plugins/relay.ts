import { definePlugin } from "nitro";

import { enqueueTenantSyncs, onRelayKick, relayOnce } from "@/db/outbox";
import { appDb, systemDb } from "@/db/pool";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { processConversationLogPass } from "@/lib/observability.server";

import { deliver } from "./relay-deliver";

const logger = createLogger("relay");

const POLL_MS = 2_000;
const BATCH = 20;
/** How often every tenant gets a delta sync, whatever the webhook brings. `SYNC_INTERVAL_MS` overrides it. */
const SYNC_MS = 5 * 60_000;
const LOOP = Symbol.for("agentic-chat.relay-loop");

/**
 * The outbox relay, as a loop in the dev server: it drains the outbox on every kick (a request that wrote a row
 * kicks it after commit) and every two seconds as the safety net. It crosses tenants, so it runs on the owner's
 * pool. On Vercel this becomes a cron route (section 22).
 *
 * Beside it, every tenant gets a delta sync every `SYNC_INTERVAL_MS`. Graph sends nothing when the directory
 * changes, and every sync renews the drive subscription, which would lapse after three days without a change.
 */
function startLoop(syncMs: number): () => void {
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
      // Log rows a sink error left unclaimed get no second delivery: each pass drains them, bounded.
      const log = await processConversationLogPass()?.();
      if (log && (log.exported || log.gone || log.error)) logger.info("conversation log pass", { ...log });
    } catch (error) {
      logger.error("relay pass failed", { error });
    } finally {
      running = false;
    }
  }

  async function queueSyncs() {
    try {
      const queued = await enqueueTenantSyncs(systemDb(), appDb(), "delta");
      if (queued.some((q) => q.id)) void drain();
    } catch (error) {
      logger.error("periodic sync failed", { error });
    }
  }

  const timer = setInterval(() => void drain(), POLL_MS);
  const syncTimer = setInterval(() => void queueSyncs(), syncMs);
  const off = onRelayKick(() => void drain());
  void drain();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearInterval(syncTimer);
    off();
  };
}

export default definePlugin(() => {
  if (acEnv() !== "dev") return;
  // A reload runs plugins again: one loop per process.
  const store = globalThis as typeof globalThis & { [LOOP]?: () => void };
  store[LOOP]?.();
  const syncMs = Number(process.env.SYNC_INTERVAL_MS) || SYNC_MS;
  store[LOOP] = startLoop(syncMs);
  logger.info("relay started", { pollMs: POLL_MS, syncMs });
});
