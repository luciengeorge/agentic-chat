// @vitest-environment node
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SlotSwitch } from "./switch";

import { main } from "./cli";
import { ExError } from "./errors";
import { readState } from "./state";
import { CancelSkipped } from "./switch";
import { makeRepo, readme, refused, VITEST_CONFIG } from "./test-repo";

const GREETING = { title: "Greeting", type: "graded", slots: { "_sample/greeting": "greeting.ts" } };
const FILES = {
  "src/core/_sample/greeting.ts": "export const formatGreeting = (name: string) => `hello ${name}`;\n",
  "exercises/00.tour/README.md": readme({ title: "Tour" }),
  "exercises/00.tour/01.problem.run/README.md": readme({ title: "Run", type: "guided" }),
  "exercises/00.tour/01.solution.run/README.md": readme({ title: "Run", type: "guided" }),
  "exercises/_smoke/README.md": readme({ title: "Smoke", hidden: true }),
  "exercises/_smoke/01.problem.greeting/README.md": readme(GREETING),
  "exercises/_smoke/01.problem.greeting/greeting.ts":
    "export function formatGreeting(name: string): string {\n  throw new Error(`not written: ${name}`);\n}\n",
  "exercises/_smoke/01.problem.greeting/greeting.test.ts": `import { expect, test } from "vitest";
import { formatGreeting } from "#learn/_sample/greeting";

test("greets by name", () => {
  expect(formatGreeting("x")).toBe("hello x");
});
`,
  "exercises/_smoke/01.solution.greeting/README.md": readme(GREETING),
  "exercises/_smoke/01.solution.greeting/greeting.ts":
    "export function formatGreeting(name: string): string {\n  return `hello ${name}`;\n}\n",
};
const PROBLEM = "exercises/_smoke/01.problem.greeting";
const SOLUTION = "exercises/_smoke/01.solution.greeting";

type SwitchEvent = { event: "pause" | "cancel" | "restart"; active: string | null; greeting: string | null };

/** A dev server and a local world that record each call with the active step and the playground's greeting. */
class FakeSwitch implements SlotSwitch {
  events: SwitchEvent[] = [];
  devServer = true;
  /** Requests still open when the pause stopped waiting. */
  open = 0;
  errors: Partial<Record<SwitchEvent["event"], Error>> = {};
  constructor(private readonly root: string) {}

  private record(event: SwitchEvent["event"]): void {
    const file = join(this.root, "playground/greeting.ts");
    this.events.push({
      event,
      active: readState(this.root).activeStep,
      greeting: existsSync(file) ? readFileSync(file, "utf8") : null,
    });
    if (this.errors[event]) throw this.errors[event];
  }

  async pauseDevServer() {
    if (!this.devServer) return null;
    this.record("pause");
    return { open: this.open, restart: async () => this.record("restart") };
  }

  async cancelOpenRuns(): Promise<string[]> {
    this.record("cancel");
    return ["wrun_1"];
  }
}

/** A stack with nothing running, so the smoke checks fail fast instead of finding the real one. */
const STACK_DOWN = {
  databaseUrl: "postgres://ac:ac@127.0.0.1:1/ac",
  appUrl: "http://localhost:3000",
  workspaceUrl: "http://localhost:8100",
  corpusDir: "fixtures/corpus/build",
  readyTimeoutMs: 0,
  fetch: refused,
};

// These run a step's tests, each in one or two fresh Vitest processes: about a second each here, a
// few on a small CI runner.
const SPAWNS_VITEST = { timeout: 15_000 };

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function setup() {
  const { root, cleanup } = makeRepo(FILES);
  cleanups.push(cleanup);
  const slotSwitch = new FakeSwitch(root);
  const path = (rel: string) => join(root, rel);
  const read = (rel: string) => readFileSync(path(rel), "utf8");
  const write = (rel: string, text: string) => writeFileSync(path(rel), text);
  const playground = () => (existsSync(path("playground")) ? readdirSync(path("playground")).sort() : null);

  async function ex(args: string[], { ok = true, json = true } = {}) {
    let out = "";
    let err = "";
    const code = await main(json ? [...args, "--json"] : args, {
      root,
      io: { out: (text) => (out += `${text}\n`), err: (text) => (err += `${text}\n`) },
      slotSwitch,
      smoke: STACK_DOWN,
    });
    expect(code === 0, `exit ${code}\n${out}${err}`).toBe(ok);
    return json ? JSON.parse(out) : { out, err };
  }

  return { root, slotSwitch, path, read, write, playground, ex };
}

describe("list", () => {
  it("shows the visible sections, with each step's dirs and status", async () => {
    const { ex } = setup();
    expect(await ex(["list"])).toEqual({
      sections: [
        {
          id: "00",
          slug: "tour",
          title: "Tour",
          hidden: false,
          steps: [
            {
              id: "00.1",
              slug: "run",
              title: "Run",
              type: "guided",
              problem_dir: "exercises/00.tour/01.problem.run",
              solution_dir: "exercises/00.tour/01.solution.run",
              status: "not_started",
            },
          ],
        },
      ],
    });
  });

  it("includes hidden sections with --all, after the numbered ones", async () => {
    const { ex } = setup();
    const { sections } = await ex(["list", "--all"]);
    expect(sections.map((s: { id: string }) => s.id)).toEqual(["00", "_smoke"]);
    expect(sections[1]).toMatchObject({ hidden: true, steps: [{ id: "_smoke.1", type: "graded" }] });
  });
});

describe("start, reset and solution", () => {
  it("start copies the problem's code but not its tests, and makes the step active", async () => {
    const { ex, read, playground, root } = setup();
    expect(await ex(["start", "_smoke.1"])).toEqual({
      step: "_smoke.1",
      files: ["greeting.ts"],
      already_active: false,
      restarted: ["dev server"],
      cancelled: ["wrun_1"],
      skipped: [],
    });
    expect(playground()).toEqual(["greeting.ts"]);
    expect(read("playground/greeting.ts")).toBe(read(`${PROBLEM}/greeting.ts`));
    expect(JSON.parse(read(".ex/state.json"))).toEqual({ active_step: "_smoke.1", passed: [] });
    expect(readState(root).activeStep).toBe("_smoke.1");
  });

  it("pauses the dev server, cancels the open runs, swaps the files, then restarts it", async () => {
    const { ex, read, slotSwitch } = setup();
    await ex(["start", "_smoke.1"]);
    await ex(["solution", "_smoke.1"]);
    await ex(["reset", "_smoke.1"]);
    const problem = read(`${PROBLEM}/greeting.ts`);
    const solution = read(`${SOLUTION}/greeting.ts`);
    const swap = (before: SwitchEvent["greeting"], after: string, active = "_smoke.1") => [
      { event: "pause", active: before === null ? null : active, greeting: before },
      { event: "cancel", active: before === null ? null : active, greeting: before },
      { event: "restart", active, greeting: after },
    ];
    expect(slotSwitch.events).toEqual([...swap(null, problem), ...swap(problem, solution), ...swap(solution, problem)]);
    expect(read("playground/greeting.ts")).toBe(problem);
  });

  it("restarts nothing when no dev server runs", async () => {
    const { ex, slotSwitch } = setup();
    slotSwitch.devServer = false;
    expect(await ex(["start", "_smoke.1"])).toMatchObject({ restarted: [], cancelled: ["wrun_1"] });
    expect(slotSwitch.events.map((e) => e.event)).toEqual(["cancel"]);
  });

  it("leaves the files as they were, and restarts the dev server on them, when cancelling fails", async () => {
    const { ex, slotSwitch, playground, root } = setup();
    slotSwitch.errors.cancel = new Error("permission denied");
    expect(await ex(["start", "_smoke.1"], { ok: false })).toEqual({
      error: "couldn't cancel the open workflow runs, so the step wasn't switched",
      detail: "Error: permission denied",
    });
    expect(readState(root).activeStep).toBeNull();
    expect(playground()).toBeNull();
    expect(slotSwitch.events).toEqual([
      { event: "pause", active: null, greeting: null },
      { event: "cancel", active: null, greeting: null },
      { event: "restart", active: null, greeting: null },
    ]);
  });

  it("switches nothing when the dev server can't be paused", async () => {
    const { ex, slotSwitch, playground, root } = setup();
    slotSwitch.errors.pause = new ExError(
      "couldn't pause the dev server at http://localhost:3000",
      "pause answered 403",
    );
    expect(await ex(["start", "_smoke.1"], { ok: false })).toEqual({
      error: "couldn't pause the dev server, so the step wasn't switched",
      detail: "couldn't pause the dev server at http://localhost:3000\npause answered 403",
    });
    expect(readState(root).activeStep).toBeNull();
    expect(playground()).toBeNull();
    expect(slotSwitch.events.map((e) => e.event)).toEqual(["pause"]);
  });

  it("keeps the switch, and says so, when the restart fails", async () => {
    const { ex, slotSwitch, root } = setup();
    slotSwitch.errors.restart = new ExError(
      "couldn't restart the dev server at http://localhost:3000",
      "no new server after 60 s; its terminal shows why",
    );
    expect(await ex(["start", "_smoke.1"])).toMatchObject({
      restarted: [],
      skipped: [
        "restart: couldn't restart the dev server at http://localhost:3000: no new server after 60 s; its terminal shows why",
      ],
    });
    expect(readState(root).activeStep).toBe("_smoke.1");
  });

  it("goes ahead, and says so, when requests were still open after the pause's wait", async () => {
    const { ex, slotSwitch } = setup();
    slotSwitch.open = 2;
    expect(await ex(["start", "_smoke.1"])).toMatchObject({
      restarted: ["dev server"],
      skipped: ["drain: 2 request(s) hadn't answered when the pause stopped waiting; a run one starts isn't cancelled"],
    });
  });

  it("goes ahead, and says so, when cancelling is skipped", async () => {
    const { ex, slotSwitch } = setup();
    slotSwitch.errors.cancel = new CancelSkipped("AC_ENV is test, not dev");
    expect(await ex(["start", "_smoke.1"])).toMatchObject({
      restarted: ["dev server"],
      cancelled: [],
      skipped: ["cancel: AC_ENV is test, not dev"],
    });
  });

  it("start on the active step keeps your work, and reset throws it away", async () => {
    const { ex, read, write } = setup();
    await ex(["start", "_smoke.1"]);
    write("playground/greeting.ts", "mine");
    expect(await ex(["start", "_smoke.1"])).toEqual({ step: "_smoke.1", files: [], already_active: true });
    expect(read("playground/greeting.ts")).toBe("mine");
    await ex(["reset", "_smoke.1"]);
    expect(read("playground/greeting.ts")).toBe(read(`${PROBLEM}/greeting.ts`));
  });

  it.each(["problem", "solution"])("start on another step clears an untouched %s copy", async (copy) => {
    const { ex, playground } = setup();
    await ex(["start", "_smoke.1"]);
    if (copy === "solution") await ex(["solution", "_smoke.1"]);
    await ex(["start", "00.1"]);
    expect(playground()).toEqual([]);
  });

  it("refuses to discard your changes without --force", async () => {
    const { ex, read, write, playground, root } = setup();
    await ex(["start", "_smoke.1"]);
    write("playground/greeting.ts", "mine");
    expect(await ex(["start", "00.1"], { ok: false })).toEqual({
      error: "playground/ has changes to _smoke.1 that `pnpm ex start 00.1` would discard",
      detail: "`pnpm ex diff _smoke.1` shows them; `pnpm ex start 00.1 --force` discards them",
    });
    expect(read("playground/greeting.ts")).toBe("mine");
    expect(readState(root).activeStep).toBe("_smoke.1");

    await ex(["start", "00.1", "--force"]);
    expect(playground()).toEqual([]);
    expect(readState(root).activeStep).toBe("00.1");
  });

  it("counts an extra playground file as a change", async () => {
    const { ex, write } = setup();
    await ex(["start", "_smoke.1"]);
    write("playground/notes.ts", "");
    await ex(["start", "00.1"], { ok: false });
  });

  it("solution needs the step to be active", async () => {
    const { ex } = setup();
    expect(await ex(["solution", "_smoke.1"], { ok: false })).toEqual({
      error: "step _smoke.1 isn't active (active: none)",
      detail: "run `pnpm ex start _smoke.1` first",
    });
  });

  it("diff shows the playground against the solution", async () => {
    const { ex } = setup();
    await ex(["start", "_smoke.1"]);
    const { files } = await ex(["diff", "_smoke.1"]);
    expect(files).toEqual([
      { path: "greeting.ts", changed: true, diff: expect.stringContaining("+  return `hello ${name}`;") },
    ]);
    expect(files[0].diff).toMatch(/^--- playground\/greeting\.ts\n\+\+\+ solution\/greeting\.ts\n@@ /);
    await ex(["solution", "_smoke.1"]);
    expect((await ex(["diff", "_smoke.1"])).files).toEqual([{ path: "greeting.ts", changed: false, diff: "" }]);
  });
});

describe("test", SPAWNS_VITEST, () => {
  it("fails against the problem code, naming each failed test", async () => {
    const { ex } = setup();
    expect(await ex(["test", "_smoke.1", "--target", "problem"], { ok: false })).toEqual({
      step: "_smoke.1",
      target: "problem",
      passed: false,
      tests: [
        {
          nodeid: `${PROBLEM}/greeting.test.ts > greets by name`,
          outcome: "failed",
          duration_s: expect.any(Number),
          message: "Error: not written: x",
        },
      ],
    });
  });

  it("grades the playground, and marks the step passed", async () => {
    const { ex, write } = setup();
    expect(await ex(["test", "_smoke.1"], { ok: false })).toEqual({
      error: "step _smoke.1 isn't active (active: none)",
      detail: "run `pnpm ex start _smoke.1` first",
    });
    await ex(["start", "_smoke.1"]);
    const status = async () => (await ex(["list", "--all"])).sections[1].steps[0].status;
    expect(await status()).toBe("active");
    // The problem code, then wrong code of your own: both fail.
    expect(await ex(["test", "_smoke.1"], { ok: false })).toMatchObject({
      target: "playground",
      passed: false,
      tests: [{ outcome: "failed", message: "Error: not written: x" }],
    });
    write("playground/greeting.ts", "export const formatGreeting = (name: string) => `hi ${name}`;\n");
    expect(await ex(["test", "_smoke.1"], { ok: false })).toMatchObject({
      passed: false,
      tests: [{ outcome: "failed", message: expect.stringContaining("expected 'hi x' to be 'hello x'") }],
    });
    expect(await status()).toBe("active");
    await ex(["solution", "_smoke.1"]);
    expect(await ex(["test", "_smoke.1"])).toMatchObject({ target: "playground", passed: true });
    await ex(["start", "00.1"]);
    expect(await status()).toBe("passed");
  });

  it("runs *.workflow.test.ts in the workflows project, with a Workflow test root of its own", async () => {
    const { ex, write, path } = setup();
    const workflows = '{ extends: false, plugins: [learnSlots()], test: { name: "workflows", environment: "node" } }';
    write(
      "vitest.config.ts",
      VITEST_CONFIG.replace('environment: "node"', `environment: "jsdom", projects: [${workflows}]`),
    );
    write(
      `${PROBLEM}/greeting.test.ts`,
      `import { expect, test } from "vitest";
import { formatGreeting } from "#learn/_sample/greeting";

test("runs under jsdom", () => {
  expect(typeof window).toBe("object");
  expect(formatGreeting("x")).toBe("hello x");
});
`,
    );
    write(
      `${PROBLEM}/greeting.workflow.test.ts`,
      `import { existsSync, writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { formatGreeting } from "#learn/_sample/greeting";

test("runs in node, with its own workflow root", () => {
  const dir = process.env.AC_WORKFLOW_TEST_ROOT ?? "";
  writeFileSync("workflow-root.txt", dir);
  expect(typeof window).toBe("undefined");
  expect(dir).toContain("node_modules/.cache/workflow-vitest-ex-");
  expect(existsSync(dir)).toBe(true);
  expect(formatGreeting("x")).toBe("hello x");
});
`,
    );
    const out = await ex(["test", "_smoke.1", "--target", "solution"]);
    expect(out.tests.map((test: { nodeid: string; outcome: string }) => [test.nodeid, test.outcome])).toEqual([
      [`${PROBLEM}/greeting.test.ts > runs under jsdom`, "passed"],
      [`${PROBLEM}/greeting.workflow.test.ts > runs in node, with its own workflow root`, "passed"],
    ]);
    expect(existsSync(readFileSync(path("workflow-root.txt"), "utf8"))).toBe(false);
  });

  it.each([
    "@/core/_sample/greeting",
    "#/core/_sample/greeting",
    "src/core/_sample/greeting",
    "/src/core/_sample/greeting.ts",
    "../src/core/_sample/greeting.ts",
    "../src/core/_sample/greeting.js",
  ])("refuses a playground that passes on the reference, imported as %s", async (specifier) => {
    const { ex, write, root } = setup();
    await ex(["start", "_smoke.1"]);
    write("playground/greeting.ts", `export { formatGreeting } from "${specifier}";\n`);
    expect(await ex(["test", "_smoke.1"], { ok: false })).toEqual({
      error:
        `playground/greeting.ts imports ${specifier}, the reference for _sample/greeting; ` +
        "a slot has to hold your own code, so the tests grade it and not the reference",
      detail: null,
    });
    expect(readState(root).passed).toEqual([]);
  });

  it("refuses the reference behind another playground file, or behind a dynamic import", async () => {
    const { ex, write } = setup();
    await ex(["start", "_smoke.1"]);
    write("playground/greeting.ts", 'export { formatGreeting } from "./helper";\n');
    write("playground/helper.ts", 'export const { formatGreeting } = await import("../src/core/_sample/greeting");\n');
    expect((await ex(["test", "_smoke.1"], { ok: false })).error).toMatch(
      /^playground\/helper\.ts imports \.\.\/src\/core\/_sample\/greeting, the reference for _sample\/greeting; /,
    );
  });

  it("refuses a step with no tests and a bad target", async () => {
    const { ex } = setup();
    expect((await ex(["test", "00.1"], { ok: false })).error).toBe("00.1 is a guided step; it has no tests");
    expect((await ex(["test", "_smoke.1", "--target", "mine"], { ok: false })).error).toBe(
      "--target must be one of playground, problem, solution",
    );
  });
});

describe("gate", SPAWNS_VITEST, () => {
  it("passes when the problem fails and the solution passes", async () => {
    const { ex } = setup();
    const out = await ex(["gate"]);
    expect(out.passed).toBe(true);
    expect(out.steps).toEqual([
      {
        step: "_smoke.1",
        passed: true,
        reasons: [],
        problem: expect.objectContaining({ target: "problem", passed: false }),
        solution: expect.objectContaining({ target: "solution", passed: true }),
      },
    ]);
  });

  it("fails when the problem's tests already pass", async () => {
    const { ex, path } = setup();
    cpSync(path(`${SOLUTION}/greeting.ts`), path(`${PROBLEM}/greeting.ts`));
    const out = await ex(["gate"], { ok: false });
    expect(out.steps[0].reasons).toEqual(["problem tests pass; they grade nothing"]);
  });

  it("fails when the problem's tests error instead of failing", async () => {
    const { ex, write } = setup();
    write(`${PROBLEM}/greeting.ts`, 'import "./missing";\nexport const formatGreeting = () => "";\n');
    const out = await ex(["gate"], { ok: false });
    expect(out.steps[0].reasons).toEqual(["problem tests error instead of failing", "problem tests have errors"]);
    expect(out.steps[0].problem.tests).toEqual([
      expect.objectContaining({ nodeid: `${PROBLEM}/greeting.test.ts`, outcome: "error" }),
    ]);
  });

  it("fails without running anything when the solution passes on the reference", async () => {
    const { ex, write } = setup();
    write(`${SOLUTION}/greeting.ts`, 'export { formatGreeting } from "../../../src/core/_sample/greeting";\n');
    const out = await ex(["gate"], { ok: false });
    expect(out.steps[0]).toMatchObject({
      reasons: [
        `${SOLUTION}/greeting.ts imports ../../../src/core/_sample/greeting, the reference for _sample/greeting`,
      ],
      problem: null,
      solution: null,
    });
  });

  it("fails without running anything when the solution dir holds tests", async () => {
    const { ex, path } = setup();
    cpSync(path(`${PROBLEM}/greeting.test.ts`), path(`${SOLUTION}/greeting.test.ts`));
    const out = await ex(["gate"], { ok: false });
    expect(out.steps[0]).toMatchObject({
      reasons: [`${SOLUTION} has test files (greeting.test.ts); a step's tests live in its problem dir only`],
      problem: null,
      solution: null,
    });
  });

  it("runs only the step's tests when the config splits into projects", async () => {
    const { ex, write } = setup();
    const projects = '[{ extends: true, test: { name: "app", include: ["src/**/*.test.ts"] } }]';
    write(
      "vitest.config.ts",
      VITEST_CONFIG.replace('environment: "node"', `environment: "node", projects: ${projects}`),
    );
    write(
      "src/other.test.ts",
      'import { test } from "vitest";\n\ntest("other", () => {\n  throw new Error("ran");\n});\n',
    );
    const out = await ex(["gate"]);
    expect(out.steps[0].problem.tests.map((test: { nodeid: string }) => test.nodeid)).toEqual([
      `${PROBLEM}/greeting.test.ts > greets by name`,
    ]);
  });

  it("fails when any step's solution dir holds tests, graded or not", async () => {
    const { ex, write } = setup();
    write("exercises/00.tour/01.solution.run/run.test.ts", "");
    const out = await ex(["gate"], { ok: false });
    expect(out.steps.map((s: { step: string; passed: boolean }) => [s.step, s.passed])).toEqual([
      ["00.1", false],
      ["_smoke.1", true],
    ]);
    expect(out.steps[0].reasons).toEqual([
      "exercises/00.tour/01.solution.run has test files (run.test.ts); a step's tests live in its problem dir only",
    ]);
  });
});

describe("smoke", SPAWNS_VITEST, () => {
  const app = "failed (ECONNREFUSED); is `pnpm dev` running?";
  const notReady = `the app isn't ready: GET http://localhost:3000/api/me ${app}`;
  const workspaceDown = "GET http://localhost:8100/health failed (ECONNREFUSED); is `pnpm fake-workspace` running?";

  it("reports each check on its own, and wants the gate to cover _smoke.2", async () => {
    const { ex } = setup();
    const out = await ex(["smoke"], { ok: false });
    expect(out.passed).toBe(false);
    expect(out.checks.map((check: { duration_s: unknown }) => check.duration_s)).toEqual(
      Array(12).fill(expect.any(Number)),
    );
    expect(out.checks.map(({ name, passed, detail }: Record<string, unknown>) => [name, passed, detail])).toEqual([
      ["paradedb extensions and queries", false, "nothing answers at 127.0.0.1:1; `pnpm ex up` starts ParadeDB"],
      ["sign in and /api/me", false, notReady],
      ["banned user refused", false, notReady],
      ["fake-workspace sharing and directory", false, workspaceDown],
      ["spike workflow", false, notReady],
      ["ex gate", false, "the gate didn't check _smoke.2"],
      ["ingestion", false, workspaceDown],
      ["retrieval", false, "nothing answers at 127.0.0.1:1; `pnpm ex up` starts ParadeDB"],
      ["answer", false, notReady],
      ["agent", false, notReady],
      ["approval", false, notReady],
      ["red-team", false, workspaceDown],
    ]);
  });

  it("passes the gate check when every graded step passes, _smoke.1 and _smoke.2 among them", async () => {
    const { ex, path } = setup();
    cpSync(path(PROBLEM), path("exercises/_smoke/02.problem.greeting-again"), { recursive: true });
    cpSync(path(SOLUTION), path("exercises/_smoke/02.solution.greeting-again"), { recursive: true });
    const out = await ex(["smoke"], { ok: false });
    expect(out.checks[5]).toMatchObject({ name: "ex gate", passed: true, detail: "passed _smoke.1, _smoke.2" });
  });

  it("fails the gate check when a graded step fails the gate", async () => {
    const { ex, path } = setup();
    cpSync(path(`${SOLUTION}/greeting.ts`), path(`${PROBLEM}/greeting.ts`));
    const out = await ex(["smoke"], { ok: false });
    expect(out.checks[5]).toMatchObject({
      name: "ex gate",
      passed: false,
      detail: "_smoke.1: problem tests pass; they grade nothing",
    });
  });
});

describe("errors", () => {
  it.each([
    [["start", "99.9"], "no step 99.9", "run `pnpm ex list --all` to see every step"],
    [["start"], "start: missing <step>", "usage: pnpm ex start <step> [--force]"],
    [["list", "extra"], "list: too many arguments", "usage: pnpm ex list [--all]"],
  ])("%j prints the error shape", async (args, error, detail) => {
    const { ex } = setup();
    const out = await ex(args, { ok: false });
    expect(out).toEqual({ error, detail: detail ?? expect.anything() });
  });

  it("names an unknown command or option", async () => {
    const { ex } = setup();
    expect(await ex(["frobnicate"], { ok: false })).toMatchObject({ error: 'unknown command "frobnicate"' });
    expect((await ex(["list", "--force"], { ok: false })).error).toMatch(/Unknown option '--force'/);
  });

  it("prints errors to stderr without --json", async () => {
    const { ex } = setup();
    const { out, err } = await ex(["start", "99.9"], { ok: false, json: false });
    expect(out).toBe("");
    expect(err).toBe("error: no step 99.9\nrun `pnpm ex list --all` to see every step\n");
  });
});
