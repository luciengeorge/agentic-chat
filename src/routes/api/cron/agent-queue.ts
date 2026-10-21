import { createFileRoute } from "@tanstack/react-router";

import { handleCron, OTHER_METHODS } from "./-cron";
import { CRON_JOBS } from "./-jobs";

export const Route = createFileRoute("/api/cron/agent-queue")({
  server: {
    handlers: {
      GET: ({ request }) => handleCron(request, "agent-queue", CRON_JOBS["agent-queue"]),
      ...OTHER_METHODS,
    },
  },
});
