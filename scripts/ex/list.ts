import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import type { Step, StepType } from "./catalog";
import type { State } from "./state";

import { SECTION_DIR, STEP_README } from "../../vite-plugins/learn-slots";
import { loadCatalog } from "./catalog";
import { localEnv } from "./env";
import { readState } from "./state";

export type StepStatus = "active" | "passed" | "not_started";

/** A step as `ex list --json` prints it. `status` says "active" for the active step even once it passed; `passed` doesn't. */
export type StepRow = {
  id: string;
  slug: string;
  title: string;
  type: StepType;
  problem_dir: string;
  solution_dir: string;
  status: StepStatus;
  passed: boolean;
};

export type SectionRow = { id: string; slug: string; title: string; hidden: boolean; steps: StepRow[] };

export function stepRow(step: Step, root: string, state: State): StepRow {
  const passed = state.passed.includes(step.id);
  return {
    id: step.id,
    slug: step.slug,
    title: step.title,
    type: step.type,
    problem_dir: relative(root, step.problemDir),
    solution_dir: relative(root, step.solutionDir),
    status: step.id === state.activeStep ? "active" : passed ? "passed" : "not_started",
    passed,
  };
}

/** The sections and steps `ex list` shows, with the learner's progress (`all` includes the hidden ones). */
export function listSections(root: string, { all = false }: { all?: boolean } = {}): SectionRow[] {
  const state = readState(root);
  const sections: SectionRow[] = [];
  for (const section of loadCatalog(root)) {
    const steps = section.steps.filter((step) => all || !step.hidden);
    if ((section.hidden && !all) || steps.length === 0) continue;
    sections.push({
      id: section.id,
      slug: section.slug,
      title: section.title,
      hidden: section.hidden,
      steps: steps.map((step) => stepRow(step, root, state)),
    });
  }
  return sections;
}

export type Next = { readme: string; test: string | null; lab: string | null };

/** What to do once a step is active: read its README, run its tests, open its section's lab if it has one. */
export function nextFor(root: string, step: Step): Next {
  const section = SECTION_DIR.exec(basename(dirname(step.problemDir)))?.groups;
  const slug = section?.slug ?? null;
  const app = (localEnv(root).BETTER_AUTH_URL || "http://localhost:3000").replace(/\/$/, "");
  return {
    readme: relative(root, join(step.problemDir, STEP_README)),
    test: step.type === "graded" ? `pnpm ex test ${step.id}` : null,
    lab: slug && existsSync(join(root, "src/routes/labs", `${slug}.tsx`)) ? `${app}/labs/${slug}` : null,
  };
}
