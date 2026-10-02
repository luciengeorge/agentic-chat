import { createFileRoute } from "@tanstack/react-router";

import { getViewer } from "@/lib/auth-server";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: async ({ request }) => Response.json(await getViewer(request.headers)),
    },
  },
});
