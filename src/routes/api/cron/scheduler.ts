import { createFileRoute } from "@tanstack/react-router";

import { handleCron, OTHER_METHODS } from "./-cron";
import { CRON_JOBS } from "./-jobs";

export const Route = createFileRoute("/api/cron/scheduler")({
  server: {
    handlers: {
      GET: ({ request }) => handleCron(request, "scheduler", CRON_JOBS.scheduler),
      ...OTHER_METHODS,
    },
  },
});
