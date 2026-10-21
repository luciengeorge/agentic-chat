// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runDrillTest } from "./drill";
import { DRILL_PLANTED, drillPlanted } from "./drill-guard";
import { envWithoutVitest, makeRepo } from "./test-repo";

const GUARD = join(import.meta.dirname, "drill-guard.ts");
const TEST = `import { expect, test } from "vitest";
test("runs", () => expect(1).toBe(1));
`;

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

/** A test repo whose Vitest config has the guard, as the real one does. */
function repo() {
  const { root, cleanup } = makeRepo({
    "vitest.config.ts": `export default { test: { environment: "node", globalSetup: [${JSON.stringify(GUARD)}] } };\n`,
    "src/thing.test.ts": TEST,
  });
  cleanups.push(cleanup);
  const journal = (body: string) => {
    mkdirSync(join(root, ".ex"), { recursive: true });
    writeFileSync(join(root, ".ex/drill.json"), body);
  };
  const vitest = (env: Record<string, string> = {}) => {
    const run = spawnSync(join(root, "node_modules/.bin/vitest"), ["run"], {
      cwd: root,
      env: envWithoutVitest(env),
      encoding: "utf8",
    });
    return { code: run.status, output: `${run.stdout}${run.stderr}` };
  };
  return { root, journal, vitest };
}

describe("drillPlanted", () => {
  it("reads the journal: none, or none active, is no drill; a sealed one, or one it can't read, is", () => {
    const { root, journal } = repo();
    expect(drillPlanted(root)).toBe(false);
    journal(JSON.stringify({ active: null, passed: ["leaver"] }));
    expect(drillPlanted(root)).toBe(false);
    journal(JSON.stringify({ active: "c2VhbGVk", passed: [] }));
    expect(drillPlanted(root)).toBe(true);
    journal("{not json");
    expect(drillPlanted(root), "can't tell: refuse, and `drill reset` repairs it").toBe(true);
  });
});

describe("the Vitest guard (pnpm test)", { timeout: 30_000 }, () => {
  it("runs the suite when no drill is planted", () => {
    const { vitest } = repo();
    expect(vitest().code).toBe(0);
  });

  it("refuses the whole suite while a drill is planted, saying why and what to run", () => {
    const { journal, vitest } = repo();
    journal(JSON.stringify({ active: "c2VhbGVk", passed: [] }));
    const { code, output } = vitest();
    expect(code).not.toBe(0);
    expect(output).toContain(DRILL_PLANTED);
    expect(output).not.toMatch(/✓ .*runs/);
  });

  it("lets `ex drill check` run the fault's own test while the drill is planted", async () => {
    const { root, journal } = repo();
    journal(JSON.stringify({ active: "c2VhbGVk", passed: [] }));
    const result = await runDrillTest(root, "demo", TEST, { project: null, env: envWithoutVitest() });
    expect(result).toMatchObject({ passed: true, error: null });
  });
});
