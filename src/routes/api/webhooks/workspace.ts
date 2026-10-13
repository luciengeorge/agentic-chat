import { createFileRoute } from "@tanstack/react-router";

import { kickRelay } from "@/db/outbox";
import { appDb } from "@/db/pool";

import { handleWorkspaceWebhook } from "./-workspace";

export const Route = createFileRoute("/api/webhooks/workspace")({
  server: {
    handlers: {
      POST: ({ request }) => handleWorkspaceWebhook(request, { db: appDb(), kick: kickRelay }),
    },
  },
});
