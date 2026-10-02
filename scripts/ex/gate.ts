import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import type { Step } from "./catalog";
import type { StepRun } from "./testing";

import { REFERENCE_DIR } from "../../vite-plugins/learn-slots";
import { isTestFile, loadCatalog, stepFiles } from "./catalog";
import { referenceImports, runStepTests } from "./testing";

export type GateResult = {
  step: string;
  passed: boolean;
  reasons: string[];
  problem: StepRun | null;
  solution: StepRun | null;
};

/** A step's tests live in its problem dir only, so there's one copy of each to trust. */
function strayTests(root: string, step: Step): string[] {
  const stray = stepFiles(step.solutionDir).filter(isTestFile);
  if (stray.length === 0) return [];
  return [
    `${relative(root, step.solutionDir)} has test files (${stray.join(", ")}); a step's tests live in its problem dir only`,
  ];
}

/** The problem dir's tests must fail (not error) against the problem code and pass against the solution code. */
export async function checkStep(root: string, step: Step): Promise<GateResult> {
  const reasons: string[] = [];
  const slots = Object.entries(step.slots);
  if (slots.length === 0) reasons.push("graded step declares no slots, so its tests can't grade anything");
  if (!stepFiles(step.problemDir).some(isTestFile)) reasons.push(`${relative(root, step.problemDir)} has no tests`);
  reasons.push(...strayTests(root, step));
  for (const [module, file] of slots) {
    if (!existsSync(join(root, REFERENCE_DIR, `${module}.ts`))) {
      reasons.push(`slot ${module} has no reference at ${REFERENCE_DIR}/${module}.ts`);
    }
    for (const dir of [step.problemDir, step.solutionDir]) {
      if (!existsSync(join(dir, file))) reasons.push(`${relative(root, dir)} is missing slot file ${file}`);
    }
  }
  reasons.push(...[step.problemDir, step.solutionDir].flatMap((dir) => referenceImports(root, step, dir)));
  if (reasons.length > 0) return { step: step.id, passed: false, reasons, problem: null, solution: null };

  const problem = await runStepTests(root, step, "problem", { capture: true });
  const solution = await runStepTests(root, step, "solution", { capture: true });
  if (problem.passed) reasons.push("problem tests pass; they grade nothing");
  else if (!problem.tests.some((test) => test.outcome === "failed"))
    reasons.push("problem tests error instead of failing");
  if (problem.tests.some((test) => test.outcome === "error")) reasons.push("problem tests have errors");
  if (!solution.passed) reasons.push("solution tests don't pass");
  return { step: step.id, passed: reasons.length === 0, reasons, problem, solution };
}

export async function runGate(root: string): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const section of loadCatalog(root)) {
    for (const step of section.steps) {
      if (step.type === "graded") results.push(await checkStep(root, step));
      else {
        const reasons = strayTests(root, step);
        if (reasons.length > 0) results.push({ step: step.id, passed: false, reasons, problem: null, solution: null });
      }
    }
  }
  return results;
}
