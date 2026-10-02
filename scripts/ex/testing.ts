import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { Step } from "./catalog";

import { isTestFile, isWorkflowTestFile, stepFiles } from "./catalog";
import { ExError } from "./errors";
import { run } from "./process";
import { playground } from "./workspace";

export const TARGETS = ["playground", "problem", "solution"] as const;
export type Target = (typeof TARGETS)[number];

export type TestResult = {
  nodeid: string;
  outcome: "passed" | "failed" | "skipped" | "error";
  duration_s: number;
  message: string | null;
};

export type StepRun = { step: string; target: Target; passed: boolean; tests: TestResult[] };

const RUNNER = fileURLToPath(new URL("./vitest-run.ts", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx");

export function targetDir(root: string, step: Step, target: Target): string {
  return target === "playground" ? playground(root) : target === "problem" ? step.problemDir : step.solutionDir;
}

type JsonReport = {
  testResults: {
    name: string;
    status: string;
    message: string;
    assertionResults: {
      ancestorTitles: string[];
      title: string;
      status: string;
      duration?: number | null;
      failureMessages: string[];
    }[];
  }[];
};

/** The error line(s) of a failure, without the stack trace. */
function firstMessage(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n");
  const stack = lines.findIndex((line) => /^\s+at /.test(line));
  return (stack === -1 ? lines : lines.slice(0, stack)).join("\n").trim() || null;
}

/** Vitest's JSON report, one entry per test, plus one `error` entry per file that failed outside a test. */
export function parseReport(root: string, report: JsonReport): TestResult[] {
  return report.testResults.flatMap((file) => {
    const path = relative(root, file.name);
    const tests = file.assertionResults.map((test): TestResult => ({
      nodeid: [path, ...test.ancestorTitles, test.title].join(" > "),
      outcome: test.status === "passed" ? "passed" : test.status === "failed" ? "failed" : "skipped",
      duration_s: Math.round((test.duration ?? 0) * 10) / 10_000,
      message: test.status === "failed" ? firstMessage(test.failureMessages[0]) : null,
    }));
    if (file.status === "failed" && file.message) {
      tests.push({ nodeid: path, outcome: "error", duration_s: 0, message: firstMessage(file.message) });
    }
    return tests;
  });
}

/**
 * Runs a step's tests with its slots pointed at `target`, in a fresh Vitest.
 *
 * The tests always come from the problem dir, which the learner doesn't edit; only the code under
 * test (the slot root) changes with the target.
 */
export async function runStepTests(
  root: string,
  step: Step,
  target: Target,
  { capture }: { capture: boolean },
): Promise<StepRun> {
  if (!stepFiles(step.problemDir).some(isTestFile)) {
    throw new ExError(`no *.test.ts in ${relative(root, step.problemDir)}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "ex-test-"));
  // @workflow/vitest bundles the steps into this dir. It must be inside the repo, where the bundles
  // resolve `workflow`, and this run's own, so a Vitest running alongside keeps its bundles.
  let workflowRoot: string | null = null;
  if (stepFiles(step.problemDir).some(isWorkflowTestFile)) {
    const cache = join(root, "node_modules/.cache");
    mkdirSync(cache, { recursive: true });
    workflowRoot = mkdtempSync(join(cache, "workflow-vitest-ex-"));
  }
  try {
    const report = join(tmp, "report.json");
    // A parent Vitest's variables (when ex runs inside a test) would confuse the child.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")));
    const env = {
      ...inherited,
      AC_ENV: "test",
      AC_ACTIVE_STEP: step.id,
      AC_SLOT_ROOT: targetDir(root, step, target),
      ...(workflowRoot ? { AC_WORKFLOW_TEST_ROOT: workflowRoot } : {}),
    };
    const args = ["--import", TSX, RUNNER, "--root", root, "--tests", step.problemDir, "--report", report];
    const result = await run(process.execPath, capture ? [...args, "--quiet"] : args, { cwd: root, env, capture });
    if (!existsSync(report)) {
      throw new ExError("vitest did not produce a report", capture ? `${result.stdout}${result.stderr}` : null);
    }
    // Vitest reports real paths.
    const tests = parseReport(realpathSync(root), JSON.parse(readFileSync(report, "utf8")) as JsonReport);
    const passed = result.code === 0 && tests.some((test) => test.outcome === "passed");
    return { step: step.id, target, passed, tests };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (workflowRoot) rmSync(workflowRoot, { recursive: true, force: true });
  }
}
