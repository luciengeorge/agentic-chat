import { createFileRoute } from "@tanstack/react-router";

import { stepsResponse } from "@/lib/ex.server";

export const Route = createFileRoute("/api/steps")({
  server: {
    handlers: {
      GET: () => stepsResponse(),
    },
  },
});
