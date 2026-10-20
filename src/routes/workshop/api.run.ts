import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { crossOrigin, workshopMiddleware, workshopRoot } from "@/components/workshop/access";

import { StepId } from "./-functions";

const Body = z.object({ stepId: StepId, target: z.enum(["playground", "problem", "solution"]) });

/** Runs a step's tests (`ex test --progress`) and streams each test as it ends, as server-sent events. */
export const Route = createFileRoute("/workshop/api/run")({
  server: {
    middleware: [workshopMiddleware],
    handlers: {
      POST: async ({ request }) => {
        const refused = crossOrigin(request);
        if (refused) return refused;
        const body = Body.safeParse(await request.json().catch(() => null));
        if (!body.success) return Response.json({ error: "send { stepId, target }" }, { status: 400 });
        const { exRunner, testEventStream } = await import("@/components/workshop/workshop-server");
        const stream = testEventStream(exRunner(workshopRoot()), {
          step: body.data.stepId,
          target: body.data.target,
          signal: request.signal,
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      },
    },
  },
});
