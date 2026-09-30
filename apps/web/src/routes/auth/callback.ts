import { createFileRoute } from "@tanstack/react-router";

import { getBff } from "@/lib/bff.server";

export const Route = createFileRoute("/auth/callback")({
  server: {
    handlers: {
      GET: ({ request }) => getBff().callback(request),
    },
  },
});
