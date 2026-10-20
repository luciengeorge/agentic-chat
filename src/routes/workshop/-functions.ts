import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { workshopMiddleware, workshopRoot } from "@/components/workshop/access";

const server = () => import("@/components/workshop/workshop-server");

/** A step id as `ex` names it (`04.1`, `_smoke.2`). Strict, since it ends up in a command line. */
export const StepId = z.string().regex(/^(\d{2}|_[a-z0-9-]+)\.\d{1,2}$/);
const SectionId = z.string().regex(/^(\d{2}|_[a-z0-9-]+)$/);

export const getCourse = createServerFn({ method: "GET" })
  .middleware([workshopMiddleware])
  .handler(async () => (await server()).readCourse(workshopRoot()));

export const getFrontDoor = createServerFn({ method: "GET" })
  .middleware([workshopMiddleware])
  .handler(async () => (await server()).readFrontDoor(workshopRoot()));

export const getStepPage = createServerFn({ method: "GET" })
  .middleware([workshopMiddleware])
  .validator(z.object({ stepId: z.string() }))
  .handler(async ({ data }) => {
    const page = StepId.safeParse(data.stepId).success
      ? (await server()).readStepPage(workshopRoot(), data.stepId)
      : null;
    if (!page) throw notFound();
    return page;
  });

export const getSectionPage = createServerFn({ method: "GET" })
  .middleware([workshopMiddleware])
  .validator(z.object({ sectionId: z.string() }))
  .handler(async ({ data }) => {
    const page = SectionId.safeParse(data.sectionId).success
      ? (await server()).readSectionPage(workshopRoot(), data.sectionId)
      : null;
    if (!page) throw notFound();
    return page;
  });

/** Starts `ex start|reset|solution` and answers before `ex` pauses this server; the page polls the job. */
export const startSwapFn = createServerFn({ method: "POST" })
  .middleware([workshopMiddleware])
  .validator(z.object({ command: z.enum(["start", "reset", "solution"]), stepId: StepId, force: z.boolean() }))
  .handler(async ({ data, context }) => {
    const { exRunner, startSwap, WorkshopBusy } = await server();
    try {
      const job = startSwap(exRunner(workshopRoot()), {
        command: data.command,
        step: data.stepId,
        force: data.force,
        owner: context.viewer.userId,
      });
      return { jobId: job.id, busy: null };
    } catch (error) {
      if (error instanceof WorkshopBusy) return { jobId: null, busy: error.message };
      throw error;
    }
  });

export const getDiff = createServerFn({ method: "GET" })
  .middleware([workshopMiddleware])
  .validator(z.object({ stepId: StepId }))
  .handler(async ({ data }) => {
    const { exRunner, readDiff } = await server();
    return readDiff(exRunner(workshopRoot()), data.stepId);
  });
