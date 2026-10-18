import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite";

import type { Step } from "./catalog";

import { REFERENCE_DIR } from "../../vite-plugins/learn-slots";
import { codeFiles, isTestFile, isWorkflowTestFile, stepFiles } from "./catalog";
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

/** `warnings` are things worth fixing that didn't fail the run: Postgres down, so the step's database tests skipped. */
export type StepRun = { step: string; target: Target; passed: boolean; tests: TestResult[]; warnings: string[] };

const RUNNER = fileURLToPath(new URL("./vitest-run.ts", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx");

export function targetDir(root: string, step: Step, target: Target): string {
  return target === "playground" ? playground(root) : target === "problem" ? step.problemDir : step.solutionDir;
}

/** Every module a file imports or re-exports from, by the specifier it's written with. */
function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const { module } = parseSync(file, source);
  const dynamic = module.dynamicImports
    .map(({ moduleRequest }) => source.slice(moduleRequest.start, moduleRequest.end))
    .filter((text) => /^(["'`])[^"'`$]*\1$/.test(text))
    .map((text) => text.slice(1, -1));
  return [
    ...module.staticImports.map((entry) => entry.moduleRequest.value),
    ...module.staticExports.flatMap((entry) =>
      entry.entries.flatMap((e) => (e.moduleRequest ? [e.moduleRequest.value] : [])),
    ),
    ...dynamic,
  ];
}

/** The files a specifier can name, without extension: the aliases `@/` and `#/`, `src/`, `/src/` (Vite's root) and relative paths. */
function candidates(root: string, from: string, specifier: string): string[] {
  const path = specifier.split("?")[0]!;
  const found =
    path.startsWith("@/") || path.startsWith("#/")
      ? [join(root, "src", path.slice(2))]
      : path.startsWith("src/")
        ? [join(root, path)]
        : path.startsWith("/")
          ? [path, join(root, path)]
          : path.startsWith(".")
            ? [resolve(dirname(from), path)]
            : [];
  return found.map((file) => file.replace(/\.[cm]?[jt]sx?$/, "").replace(/\/index$/, ""));
}

/**
 * Where code under test imports the reference of a module the step slots, by any path. Its tests
 * would then grade the reference: a re-export of it passes them all.
 */
export function referenceImports(root: string, step: Step, dir: string): string[] {
  const references = new Map(
    Object.keys(step.slots).map((module) => [join(root, REFERENCE_DIR, module), module] as const),
  );
  return codeFiles(dir).flatMap((name) => {
    const file = join(dir, name);
    return importSpecifiers(file).flatMap((specifier) => {
      const module = candidates(root, file, specifier)
        .map((path) => references.get(path))
        .find(Boolean);
      return module ? [`${relative(root, file)} imports ${specifier}, the reference for ${module}`] : [];
    });
  });
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

const ANSI = /\u001b\[[0-9;]*m/g;

/** The error line(s) of a failure, without the stack trace or colour codes. */
function firstMessage(text: string | undefined): string | null {
  if (!text) return null;
  const lines = text.replace(ANSI, "").split("\n");
  const stack = lines.findIndex((line) => /^\s+at /.test(line));
  return (stack === -1 ? lines : lines.slice(0, stack)).join("\n").trim() || null;
}

/**
 * Vitest's JSON report, one entry per test, plus one `error` entry per file that failed outside a test.
 * Sorted by file, and in file order within one: with projects, Vitest lists files in whatever order the projects
 * finish.
 */
export function parseReport(root: string, report: JsonReport): TestResult[] {
  return report.testResults
    .flatMap((file) => {
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
    })
    .sort((a, b) => {
      const [fileA, fileB] = [a.nodeid.split(" > ")[0]!, b.nodeid.split(" > ")[0]!];
      return fileA < fileB ? -1 : fileA > fileB ? 1 : 0;
    });
}

/** What global setup prints when it can't reach Postgres (`src/db/test/global-setup.ts`). */
const POSTGRES_DOWN = "Postgres is unreachable";

/** A step's tests use a database when one of them imports the test database helpers. */
export function hasDatabaseTests(step: Step): boolean {
  return stepFiles(step.problemDir)
    .filter(isTestFile)
    .some((name) => /["']@\/db\/testing["']/.test(readFileSync(join(step.problemDir, name), "utf8")));
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
  const [cheat, ...more] = referenceImports(root, step, targetDir(root, step, target));
  if (cheat) {
    throw new ExError(
      `${cheat}; a slot has to hold your own code, so the tests grade it and not the reference`,
      more.join("\n") || null,
    );
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
    const warnings =
      capture && `${result.stdout}${result.stderr}`.includes(POSTGRES_DOWN) && hasDatabaseTests(step)
        ? ["Postgres is unreachable, so this step's database tests were skipped. Start it with `pnpm ex up`."]
        : [];
    return { step: step.id, target, passed, tests, warnings };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    if (workflowRoot) rmSync(workflowRoot, { recursive: true, force: true });
  }
}
