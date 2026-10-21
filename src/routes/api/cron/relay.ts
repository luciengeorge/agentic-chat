import { createFileRoute } from "@tanstack/react-router";

import { handleCron, OTHER_METHODS } from "./-cron";
import { CRON_JOBS } from "./-jobs";

export const Route = createFileRoute("/api/cron/relay")({
  server: {
    handlers: {
      GET: ({ request }) => handleCron(request, "relay", CRON_JOBS.relay),
      ...OTHER_METHODS,
    },
  },
});
