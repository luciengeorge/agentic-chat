import { createFileRoute } from "@tanstack/react-router";
import { start } from "workflow/api";
import { z } from "zod";

import { spikeWorkflow } from "@/workflows/spike";

import { devOnly } from "./-dev-only";

const StartSchema = z.object({ sleepMs: z.number().int().min(0).max(60_000).default(2_000) });

export const Route = createFileRoute("/api/spike/")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const refused = devOnly();
        if (refused) return refused;

        const body = StartSchema.safeParse(await request.json().catch(() => ({})));
        if (!body.success) return Response.json({ error: body.error.issues }, { status: 400 });

        const token = `spike:${crypto.randomUUID()}`;
        const run = await start(spikeWorkflow, [token, body.data.sleepMs]);
        return Response.json({ runId: run.runId, token });
      },
    },
  },
});
