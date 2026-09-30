import { createFileRoute } from "@tanstack/react-router";

import { getBff } from "@/lib/bff.server";

export const Route = createFileRoute("/api/me")({
  server: {
    handlers: {
      GET: ({ request }) => getBff().me(request),
    },
  },
});
