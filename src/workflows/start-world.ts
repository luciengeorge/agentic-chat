import { definePlugin } from "nitro";

import { createLogger } from "@/lib/logger";

const logger = createLogger("workflows.world");

// The local world re-enqueues pending and running runs only when started, and nothing else starts it,
// so without this a restarted server leaves sleeping or queued runs stuck. Vercel's world has no worker.
export default definePlugin(() => {
  if (process.env.VERCEL) return;
  void import("workflow/runtime")
    .then(({ getWorld }) => getWorld())
    .then((world) => world.start?.())
    .catch((error: unknown) => logger.error("world start failed", { error }));
});
