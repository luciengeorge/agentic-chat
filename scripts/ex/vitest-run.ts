// Runs one step's tests in a fresh Vitest, so learn-slots resolves AC_ACTIVE_STEP and AC_SLOT_ROOT anew.
// Usage: tsx scripts/ex/vitest-run.ts --root <repo> --tests <dir> --report <file> [--quiet]
import type { TestProjectInlineConfiguration } from "vitest/config";

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { loadConfigFromFile } from "vite";
import { startVitest } from "vitest/node";

import { isTestFile, isWorkflowTestFile } from "./catalog";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    tests: { type: "string" },
    report: { type: "string" },
    quiet: { type: "boolean", default: false },
  },
});
const { root, tests, report, quiet } = values;
if (!root || !tests || !report) throw new Error("--root, --tests and --report are required");

const file = join(root, "vitest.config.ts");
const loaded = existsSync(file) ? await loadConfigFromFile({ command: "serve", mode: "test" }, file, root) : null;
const { projects = [], ...test } = loaded?.config.test ?? {};

// The repo's projects each keep their own `include`, so the step's tests run in projects of our own:
// `*.workflow.test.ts` in the repo's `workflows` project (@workflow/vitest, which can't run under
// jsdom), every other test on the root config.
const dir = relative(root, tests);
const names = readdirSync(tests).filter(isTestFile);
const WORKFLOW_TESTS = "*.workflow.test.{ts,tsx}";
const stepProjects: TestProjectInlineConfiguration[] = [];
if (names.some((name) => !isWorkflowTestFile(name))) {
  stepProjects.push({
    ...loaded?.config,
    test: {
      ...test,
      name: "step",
      include: [`${dir}/*.test.{ts,tsx}`],
      exclude: [...(test.exclude ?? []), `**/${WORKFLOW_TESTS}`],
    },
  });
}
if (names.some(isWorkflowTestFile)) {
  const workflows = projects.find(
    (project): project is TestProjectInlineConfiguration =>
      typeof project === "object" && "test" in project && project.test?.name === "workflows",
  );
  if (!workflows) throw new Error(`${dir} has workflow tests, but vitest.config.ts has no "workflows" project`);
  stepProjects.push({ ...workflows, test: { ...workflows.test, include: [`${dir}/${WORKFLOW_TESTS}`] } });
}

const vitest = await startVitest(
  "test",
  [],
  {
    root,
    config: false,
    run: true,
    watch: false,
    reporters: quiet ? ["json"] : ["default", "json"],
    outputFile: { json: report },
  },
  { test: { projects: stepProjects } },
);
await vitest.close();
