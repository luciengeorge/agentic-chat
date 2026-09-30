import { createFileRoute } from "@tanstack/react-router";

import { getBff } from "@/lib/bff.server";

export const Route = createFileRoute("/auth/logout")({
  server: {
    handlers: {
      POST: ({ request }) => getBff().logout(request),
    },
  },
});
