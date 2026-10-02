import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(parent: string, prefix: string): string {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, prefix));
  temps.push(dir);
  return dir;
}

// @workflow/vitest bundles the steps once per Vitest run, with the slots active when it starts, so each case runs
// spike.test.ts in a fresh Vitest, the way `ex test` does. Its bundles go in their own directory inside the repo
// (the builder resolves `workflow` from there), so they can't overwrite this run's. Returns what the run printed.
function runSpikeTest(env: Record<string, string>): string {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "AC_ACTIVE_STEP"),
  );
  const vitest = join(ROOT, "node_modules/vitest/vitest.mjs");
  const result = spawnSync(
    process.execPath,
    [vitest, "run", "--project", "workflows", "--silent=false", "src/workflows/spike.test.ts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...inherited,
        AC_WORKFLOW_TEST_ROOT: tempDir(join(ROOT, "node_modules/.cache"), "workflow-vitest-"),
        ...env,
      },
    },
  );
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(0);
  return output;
}

describe("#learn imports inside workflow steps under @workflow/vitest", () => {
  it("run the playground copy while the step that slots them is active", () => {
    const playground = tempDir(tmpdir(), "playground-");
    writeFileSync(
      join(playground, "greeting.ts"),
      "export const formatGreeting = (name: string) => `playground ${name}`;\n",
    );

    const output = runSpikeTest({ AC_ACTIVE_STEP: "_smoke.1", AC_SLOT_ROOT: playground });
    expect(output).toContain('"greeting":"playground step"');
  }, 60_000);

  // With no AC_ACTIVE_STEP, the slots come from .ex/state.json, which names no step in a fresh checkout or in CI.
  it("run the reference while no step is active", () => {
    const output = runSpikeTest({});
    expect(output).toContain('"greeting":"hello step"');
  }, 60_000);
});
