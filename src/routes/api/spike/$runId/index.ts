import { createFileRoute } from "@tanstack/react-router";
import { getRun } from "workflow/api";

import { devOnly } from "../-dev-only";

export const Route = createFileRoute("/api/spike/$runId/")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const refused = devOnly(request);
        if (refused) return refused;

        const run = getRun(params.runId);
        if (!(await run.exists)) return Response.json({ error: "run not found" }, { status: 404 });

        return Response.json({ runId: run.runId, status: await run.status });
      },
    },
  },
});
