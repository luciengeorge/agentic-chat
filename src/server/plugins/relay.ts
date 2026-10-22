import { definePlugin } from "nitro";

import { enqueueTenantSyncs, onRelayKick, relayOnce } from "@/db/outbox";
import { appDb, systemDb } from "@/db/pool";
import { createLogger } from "@/lib/logger";
import { processConversationLogPass } from "@/lib/observability.server";
import { pollLoop } from "@/lib/poll-loop";
import { relayPass } from "@/routes/api/cron/-cron";
import { passAfterResponse, relayMode } from "@/server/relay-kick";

import { deliver } from "./relay-deliver";

const logger = createLogger("relay");

const POLL_MS = 2_000;
const BATCH = 20;
/** How often every tenant gets a delta sync, whatever the webhook brings. `SYNC_INTERVAL_MS` overrides it. */
const SYNC_MS = 5 * 60_000;
const LOOP = Symbol.for("agentic-chat.relay-loop");

/**
 * The outbox relay, as a loop in the dev server: it drains the outbox on every kick (a request that wrote a row
 * kicks it after commit) and every two seconds as the safety net, backing off while Postgres is down. It crosses
 * tenants, so it runs on the owner's pool. On Vercel a cron route drains it every minute (section 22), and a kick runs
 * one pass after the response that wrote the row (`relayMode`).
 *
 * Beside it, every tenant gets a delta sync every `SYNC_INTERVAL_MS`. Graph sends nothing when the directory
 * changes, and every sync renews the drive subscription, which would lapse after three days without a change.
 */
function startLoop(syncMs: number): () => void {
  async function drain() {
    let full: boolean;
    do {
      const result = await relayOnce(systemDb(), deliver, { batchSize: BATCH });
      const { published, retried, failed, outage } = result;
      if (published.length || retried.length || failed.length || outage) {
        logger.info("relay pass", { published: published.length, retried, failed, outage });
      }
      full = published.length === BATCH;
    } while (full);
    // Log rows a sink error left unclaimed get no second delivery: each pass drains them, bounded.
    const log = await processConversationLogPass()?.();
    if (log && (log.exported || log.gone || log.error)) logger.info("conversation log pass", { ...log });
  }

  const loop = pollLoop({ name: "relay", intervalMs: POLL_MS, pass: drain, logger });

  async function queueSyncs() {
    try {
      const queued = await enqueueTenantSyncs(systemDb(), appDb(), "delta");
      if (queued.some((q) => q.id)) loop.kick();
    } catch (error) {
      logger.error("periodic sync failed", { error });
    }
  }

  const syncTimer = setInterval(() => void queueSyncs(), syncMs);
  const off = onRelayKick(loop.kick);
  return () => {
    loop.stop();
    clearInterval(syncTimer);
    off();
  };
}

/** One relay pass after a kick on Vercel: a batch is plenty for the row that request wrote; the cron does the rest. */
const kickPass = () => relayPass(systemDb(), deliver, { maxBatches: 1, conversationLog: processConversationLogPass() });

export default definePlugin(() => {
  const mode = relayMode();
  if (mode === "off") return;
  // A reload runs plugins again: one loop per process.
  const store = globalThis as typeof globalThis & { [LOOP]?: () => void };
  store[LOOP]?.();
  if (mode === "after-response") {
    store[LOOP] = onRelayKick(passAfterResponse(kickPass));
    return;
  }
  const syncMs = Number(process.env.SYNC_INTERVAL_MS) || SYNC_MS;
  store[LOOP] = startLoop(syncMs);
  logger.info("relay started", { pollMs: POLL_MS, syncMs });
});
