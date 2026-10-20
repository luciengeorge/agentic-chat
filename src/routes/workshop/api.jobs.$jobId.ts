import { createFileRoute } from "@tanstack/react-router";

import { workshopMiddleware } from "@/components/workshop/access";

/** A step switch's progress. The page polls it with plain fetch, through the 503s of the pause and the restart. */
export const Route = createFileRoute("/workshop/api/jobs/$jobId")({
  server: {
    middleware: [workshopMiddleware],
    handlers: {
      GET: async ({ params, context }) => {
        const { getSwapJob } = await import("@/components/workshop/workshop-server");
        // Another user's job answers like a missing one.
        const job = getSwapJob(params.jobId, context.viewer.userId);
        return job
          ? Response.json(job, { headers: { "cache-control": "no-store" } })
          : Response.json({ error: "no such job" }, { status: 404 });
      },
    },
  },
});
