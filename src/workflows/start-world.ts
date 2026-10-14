import { definePlugin } from "nitro";

import { createLogger } from "@/lib/logger";

const logger = createLogger("workflows.world");

// The local world re-enqueues pending and running runs only when started, and nothing else starts it,
// so without this a restarted server leaves sleeping or queued runs stuck. Vercel's world has no worker.
export default definePlugin(() => {
  if (process.env.VERCEL) return;
  // A step that was running when the server died is run again only once its owner's lease runs out (860 s by
  // default, sized for Vercel). Locally the dead owner never comes back, so the lease is how long a killed run
  // stalls: just longer than the longest step may take (a model turn, cut off at 120 s).
  process.env.WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS ||= "150";
  void import("workflow/runtime")
    .then(({ getWorld }) => getWorld())
    .then((world) => world.start?.())
    .catch((error: unknown) => logger.error("world start failed", { error }));
});
