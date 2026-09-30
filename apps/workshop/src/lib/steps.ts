import { z } from "zod";

export const StepSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  type: z.enum(["graded", "guided", "lab"]),
  problem_dir: z.string(),
  solution_dir: z.string(),
  status: z.enum(["not_started", "active", "passed"]),
});

export const SectionSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  hidden: z.boolean(),
  steps: z.array(StepSchema),
});

export const StepListSchema = z.object({ sections: z.array(SectionSchema) });

export const ExErrorSchema = z.object({ error: z.string(), detail: z.json().optional() });

export type Step = z.infer<typeof StepSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type StepList = z.infer<typeof StepListSchema>;
export type ExError = z.infer<typeof ExErrorSchema>;
