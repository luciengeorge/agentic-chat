// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { DrillEntry, Fault } from "@/core/drills/types";

import { seal } from "@/core/drills/seal";

import { commitAll, gitIn } from "../../../scripts/ex/drill-testing";
import { envWithoutVitest, makeRepo, readme } from "../../../scripts/ex/test-repo";
import {
  getSwapJob,
  readDrill,
  readStepPage,
  runDrillCheck,
  type SwapJob,
  startDrillJob,
  exRunner,
  WorkshopBusy,
} from "./workshop-server";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const THING = "src/core/demo/thing.ts";
const ORIGINAL = "export const answer = (): number => 42;\n";

const FAULT: Fault = {
  symptom: "At {{planted}} the answer\nwent wrong.\n\nNobody changed anything.",
  cause: "41",
  clues: ["look at the answer"],
  modules: [],
  needs: [],
  requires: [],
  files: [{ path: THING, edits: [{ find: "42", replace: "41" }] }],
  plant: [],
  undo: [],
  probes: [{ kind: "sql-none", text: "unused", explain: "the answer is still wrong" }],
  test: "",
};
const DEMO: DrillEntry = { id: "demo", title: "The answer is wrong", sealed: seal("demo", FAULT) };

/**
 * A repo with a drills section of one step, and an `ex` that knows only the demo drill. Its stack is a stand-in:
 * the symptom is gone, and the fault's test passes, when the file says 42 again.
 */
const EX = `import { readFileSync } from "node:fs";
import { main } from ${JSON.stringify(join(REPO, "scripts/ex/cli.ts"))};
import { seal } from ${JSON.stringify(join(REPO, "src/core/drills/seal.ts"))};

const fault = ${JSON.stringify(FAULT)};
const fixed = () => readFileSync(${JSON.stringify(THING)}, "utf8").includes("42");
const live = {
  preflight: async () => {},
  resolve: async () => {},
  count: async () => 1,
  act: async () => {},
  probe: async () => ({ ok: fixed(), detail: "the answer is still wrong" }),
  close: async () => {},
};
process.exitCode = await main(process.argv.slice(2), {
  root: process.cwd(),
  io: { out: (text) => console.log(text), err: (text) => console.error(text) },
  slotSwitch: { pauseDevServer: async () => null, cancelOpenRuns: async () => [] },
  drills: {
    drills: [{ id: "demo", title: "The answer is wrong", sealed: seal("demo", fault) }],
    live: () => live,
    runTest: async () => ({
      passed: fixed(),
      tests: [{ name: "answers 42", outcome: fixed() ? "passed" : "failed", message: fixed() ? null : "expected 41 to be 42" }],
      error: null,
    }),
    now: () => new Date("2026-10-21T09:15:00Z"),
  },
});
`;

const LAB = { title: "The answer is wrong", type: "lab" };
const FILES = {
  ".gitignore": "node_modules\n.ex/\n",
  "package.json": JSON.stringify({
    type: "module",
    scripts: { ex: `tsx --tsconfig ${join(REPO, "tsconfig.json")} scripts/ex.ts` },
  }),
  "scripts/ex.ts": EX,
  [THING]: ORIGINAL,
  "exercises/19.other/README.md": readme({ title: "Other" }),
  "exercises/19.other/01.problem.demo/README.md": `${readme({ title: "Not a drill", type: "guided" })}\n# Not a drill\n`,
  "exercises/19.other/01.solution.demo/README.md": readme({ title: "Not a drill", type: "guided" }),
  "exercises/20.drills/README.md": readme({ title: "Debugging drills" }),
  "exercises/20.drills/01.problem.demo/README.md": `${readme(LAB)}\n# The answer is wrong\n`,
  "exercises/20.drills/01.solution.demo/README.md": readme(LAB),
};

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function setup() {
  const { root, cleanup } = makeRepo(FILES);
  cleanups.push(cleanup);
  commitAll(root);
  return { root, run: exRunner(root, envWithoutVitest()), path: (rel: string) => join(root, rel) };
}

async function settled(job: SwapJob): Promise<SwapJob> {
  for (let i = 0; i < 1200 && getSwapJob(job.id, job.owner)?.state === "running"; i++) {
    await new Promise((done) => setTimeout(done, 50));
  }
  return getSwapJob(job.id, job.owner)!;
}

describe("a drill step's page", () => {
  it("shows the drill for a step of the drills section, and nothing for any other step", () => {
    const { root } = setup();
    expect(readStepPage(root, "20.1", [DEMO])?.drill).toEqual({
      id: "demo",
      title: "The answer is wrong",
      planted: false,
      plantedAt: null,
      symptom: null,
      other: null,
      passed: false,
      needsReset: false,
    });
    expect(readStepPage(root, "19.1", [DEMO])?.drill, "a step outside 20.drills").toBeNull();
    expect(readDrill(root, "nope", [DEMO])).toBeNull();
  });

  it("says when the journal can't be read, so reset can repair it", () => {
    const { root, path } = setup();
    mkdirSync(path(".ex"));
    writeFileSync(path(".ex/drill.json"), "{not json");
    expect(readDrill(root, "demo", [DEMO])).toMatchObject({ needsReset: true, planted: false });
  });
});

describe("plant, check and reset through `pnpm ex drill`", { timeout: 90_000 }, () => {
  it("plants the fault hidden from git, checks the fix, and puts everything back", async () => {
    const { root, run, path } = setup();
    const planted = await settled(startDrillJob(run, { command: "plant", drill: "demo", step: "20.1", owner: "leo" }));
    expect(planted).toMatchObject({ state: "done", command: "drill-plant", step: "20.1", error: null });
    expect((planted.result as { symptom: string }).symptom).toContain("the answer\nwent wrong.");
    expect(readFileSync(path(THING), "utf8")).toContain("41");
    expect(gitIn(root, ["status", "--porcelain"]), "git sees nothing").toBe("");

    const view = readDrill(root, "demo", [DEMO]);
    expect(view).toMatchObject({ planted: true, other: null, plantedAt: "2026-10-21T09:15:00.000Z" });
    expect(view?.symptom, "the symptom as ex printed it, its time filled in").toMatch(
      /^At \d\d:\d\d the answer\nwent wrong\.\n\nNobody changed anything\.$/,
    );

    expect(await runDrillCheck(run)).toMatchObject({
      checked: {
        drill: "demo",
        passed: false,
        symptom: { gone: false, probes: [{ ok: false, detail: "the answer is still wrong" }] },
        test: { passed: false, tests: [{ name: "answers 42", outcome: "failed", message: "expected 41 to be 42" }] },
      },
    });

    writeFileSync(path(THING), ORIGINAL);
    expect(await runDrillCheck(run)).toMatchObject({ checked: { passed: true, symptom: { gone: true } } });
    expect(readDrill(root, "demo", [DEMO])).toMatchObject({ planted: true, passed: true });

    const reset = await settled(startDrillJob(run, { command: "reset", drill: "demo", step: "20.1", owner: "leo" }));
    expect(reset).toMatchObject({ state: "done", command: "drill-reset", result: { drill: "demo", restored: 1 } });
    expect(readDrill(root, "demo", [DEMO])).toMatchObject({ planted: false, passed: true, symptom: null });
    expect(gitIn(root, ["ls-files", "-v", THING]).slice(0, 1), "skip-worktree cleared").toBe("H");
  });

  it("passes on ex's refusals, and runs one command at a time", async () => {
    const { run } = setup();
    expect(await runDrillCheck(run)).toEqual({
      error: "no drill is planted",
      detail: "`pnpm ex drill list` shows them; `pnpm ex drill <id>` plants one",
    });
    const job = startDrillJob(run, { command: "plant", drill: "demo", step: "20.1", owner: "leo" });
    await expect(runDrillCheck(run), "a check while the plant runs").rejects.toThrow(WorkshopBusy);
    expect((await settled(job)).state).toBe("done");
    const again = await settled(startDrillJob(run, { command: "plant", drill: "demo", step: "20.1", owner: "leo" }));
    expect(again).toMatchObject({ state: "failed", error: { error: "drill demo is planted" } });
  });
});
