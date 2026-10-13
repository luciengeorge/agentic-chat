import { createFileRoute } from "@tanstack/react-router";
import { getRun } from "workflow/api";

import type { SpikeEvent } from "@/workflows/spike";

import { devOnly } from "../-dev-only";

export const Route = createFileRoute("/api/spike/$runId/stream")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const refused = devOnly(request);
        if (refused) return refused;

        const run = getRun(params.runId);
        if (!(await run.exists)) return Response.json({ error: "run not found" }, { status: 404 });

        const ndjson = run
          .getReadable<SpikeEvent>()
          .pipeThrough(
            new TransformStream<SpikeEvent, string>({
              transform: (event, controller) => controller.enqueue(`${JSON.stringify(event)}\n`),
            }),
          )
          .pipeThrough(new TextEncoderStream());
        return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" } });
      },
    },
  },
});
