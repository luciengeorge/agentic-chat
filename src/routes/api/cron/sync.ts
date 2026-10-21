import { createFileRoute } from "@tanstack/react-router";

import { handleCron, OTHER_METHODS } from "./-cron";
import { CRON_JOBS } from "./-jobs";

export const Route = createFileRoute("/api/cron/sync")({
  server: {
    handlers: {
      GET: ({ request }) => handleCron(request, "sync", CRON_JOBS.sync),
      ...OTHER_METHODS,
    },
  },
});
