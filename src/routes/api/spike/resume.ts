import { createFileRoute } from "@tanstack/react-router";
import { resumeHook } from "workflow/api";
import { HookNotFoundError } from "workflow/errors";
import { z } from "zod";

import type { SpikeResume } from "@/workflows/spike";

import { devOnly } from "./-dev-only";

const ResumeSchema = z.object({ token: z.string().min(1), note: z.string().default("hello") });

export const Route = createFileRoute("/api/spike/resume")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const refused = devOnly(request);
        if (refused) return refused;

        const body = ResumeSchema.safeParse(await request.json().catch(() => ({})));
        if (!body.success) return Response.json({ error: body.error.issues }, { status: 400 });

        try {
          const hook = await resumeHook<SpikeResume>(body.data.token, { note: body.data.note });
          return Response.json({ runId: hook.runId });
        } catch (error) {
          // start() returns before the run registers its hook, so callers retry on 404.
          if (HookNotFoundError.is(error)) return Response.json({ error: "hook not found" }, { status: 404 });
          throw error;
        }
      },
    },
  },
});
