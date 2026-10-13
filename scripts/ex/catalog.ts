import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";

import {
  SECTION_DIR,
  STEP_DIR,
  STEP_README,
  TEST_FILE,
  readFrontmatter,
  readSlots,
} from "../../vite-plugins/learn-slots";
import { ExError } from "./errors";

export const STEP_TYPES = ["graded", "guided", "lab"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export type Step = {
  id: string;
  slug: string;
  title: string;
  type: StepType;
  hidden: boolean;
  problemDir: string;
  solutionDir: string;
  slots: Record<string, string>;
};

export type Section = { id: string; slug: string; title: string; hidden: boolean; steps: Step[] };

const IGNORED = new Set([STEP_README, ".DS_Store"]);

const SectionMeta = z.object({ title: z.string().optional(), hidden: z.boolean().default(false) });
const StepMeta = SectionMeta.extend({ type: z.enum(STEP_TYPES).default("graded") });

function parseMeta<T extends z.ZodType>(schema: T, readme: string): z.output<T> {
  const parsed = schema.safeParse(readFrontmatter(readme));
  if (!parsed.success) throw new ExError(`${readme}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function isTestFile(name: string): boolean {
  return TEST_FILE.test(name);
}

/** A test that runs workflows. It runs in the `workflows` project of vitest.config.ts. */
export function isWorkflowTestFile(name: string): boolean {
  return /\.workflow\.test\.tsx?$/.test(name);
}

/** A step dir's own files, flat and sorted: everything but its README. */
export function stepFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !IGNORED.has(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** The files a learner works on: everything but the tests, which stay in the problem dir. */
export function codeFiles(dir: string): string[] {
  return stepFiles(dir).filter((name) => !isTestFile(name));
}

function loadStep(sectionId: string, sectionHidden: boolean, problemDir: string, solutionDir: string): Step {
  const match = STEP_DIR.exec(basename(problemDir))!.groups!;
  const readme = join(problemDir, STEP_README);
  if (!existsSync(readme)) throw new ExError(`${problemDir} has no ${STEP_README}`);
  const meta = parseMeta(StepMeta, readme);
  return {
    id: `${sectionId}.${Number(match.num)}`,
    slug: match.slug!,
    title: meta.title ?? match.slug!,
    type: meta.type,
    hidden: sectionHidden || meta.hidden,
    problemDir,
    solutionDir,
    slots: readSlots(readme),
  };
}

function loadSection(dir: string, name: string): Section {
  const match = SECTION_DIR.exec(name)!.groups!;
  const readme = join(dir, STEP_README);
  const meta = existsSync(readme) ? parseMeta(SectionMeta, readme) : SectionMeta.parse({});
  const id = match.id!;
  const slug = match.slug ?? id.replace(/^_/, "");
  const problems = new Map<number, string>();
  const solutions = new Map<number, string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const step = STEP_DIR.exec(entry.name)?.groups;
    if (!entry.isDirectory() || !step) continue;
    (step.kind === "problem" ? problems : solutions).set(Number(step.num), join(dir, entry.name));
  }
  const steps = [...problems]
    .sort(([a], [b]) => a - b)
    .map(([num, problem]) => {
      const solution = solutions.get(num);
      if (!solution) throw new ExError(`${problem} has no matching solution directory`);
      return loadStep(id, meta.hidden, problem, solution);
    });
  return { id, slug, title: meta.title ?? slug, hidden: meta.hidden, steps };
}

export function loadCatalog(root: string): Section[] {
  const exercises = join(root, "exercises");
  if (!existsSync(exercises)) return [];
  const sections = readdirSync(exercises, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SECTION_DIR.test(entry.name))
    .map((entry) => loadSection(join(exercises, entry.name), entry.name));
  // Hidden sections (`_smoke`) sort after the numbered ones.
  const key = (section: Section) => `${section.id.startsWith("_") ? 1 : 0}${section.id}`;
  return sections.sort((a, b) => (key(a) < key(b) ? -1 : 1));
}

export function findStep(root: string, stepId: string): Step {
  for (const section of loadCatalog(root)) {
    const step = section.steps.find((candidate) => candidate.id === stepId);
    if (step) return step;
  }
  throw new ExError(`no step ${stepId}`, "run `pnpm ex list --all` to see every step");
}
