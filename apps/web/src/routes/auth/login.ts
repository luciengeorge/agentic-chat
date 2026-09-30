import { createFileRoute } from "@tanstack/react-router";

import { getBff } from "@/lib/bff.server";

export const Route = createFileRoute("/auth/login")({
  server: {
    handlers: {
      GET: ({ request }) => getBff().login(request),
    },
  },
});
