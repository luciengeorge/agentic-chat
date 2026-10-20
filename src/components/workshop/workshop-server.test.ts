// @vitest-environment node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { envWithoutVitest, makeRepo, readme } from "../../../scripts/ex/test-repo";
import {
  type SwapJob,
  type TestEvent,
  exRunner,
  getSwapJob,
  readCourse,
  readDiff,
  readSectionPage,
  readStepPage,
  runTests,
  startSwap,
  WorkshopBusy,
} from "./workshop-server";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const GREETING = { title: "Greeting", type: "graded", slots: { "_sample/greeting": "greeting.ts" } };
const PROBLEM = "exercises/01.basics/02.problem.greeting";
const SOLUTION = "exercises/01.basics/02.solution.greeting";
const PROBLEM_CODE = `// 👨‍💼 Kestrel greets every visitor by name.
//    A missing name reads as rude.

// 🐨 Return "hello " and the name.
// 💰 A template literal.
export function formatGreeting(name: string): string {
  throw new Error(\`not written: \${name}\`);
}
`;

/** A course of two steps, and an \`ex\` that runs this repo's CLI on it, with no dev server to pause. */
const FILES = {
  "package.json": JSON.stringify({
    type: "module",
    scripts: { ex: `tsx --tsconfig ${join(REPO, "tsconfig.json")} scripts/ex.ts` },
  }),
  "scripts/ex.ts": `import { main } from ${JSON.stringify(join(REPO, "scripts/ex/cli.ts"))};

process.exitCode = await main(process.argv.slice(2), {
  root: process.cwd(),
  io: { out: (text) => console.log(text), err: (text) => console.error(text) },
  slotSwitch: { pauseDevServer: async () => null, cancelOpenRuns: async () => [] },
});
`,
  "src/core/_sample/greeting.ts": "export const formatGreeting = (name: string) => `hello ${name}`;\n",
  "src/routes/labs/basics.tsx": "export {};\n",
  "exercises/01.basics/README.md": `${readme({ title: "Basics" })}\n# Basics\n\nA **greeting** is what you say first.\n`,
  "exercises/01.basics/FINISHED.md": `${readme({ title: "Done" })}\n# Done\n`,
  "exercises/01.basics/01.problem.tour/README.md": `${readme({ title: "Tour", type: "guided" })}\n# Tour\n`,
  "exercises/01.basics/01.solution.tour/README.md": readme({ title: "Tour", type: "guided" }),
  [`${PROBLEM}/README.md`]: `${readme(GREETING)}\n# Greeting\n\n🐨 Write \`formatGreeting\`.\n`,
  [`${PROBLEM}/greeting.ts`]: PROBLEM_CODE,
  [`${PROBLEM}/greeting.test.ts`]: `import { expect, test } from "vitest";
import { formatGreeting } from "#learn/_sample/greeting";

test("greets by name", () => {
  expect(formatGreeting("x")).toBe("hello x");
});

test("is a function", () => {
  expect(typeof formatGreeting).toBe("function");
});
`,
  [`${SOLUTION}/README.md`]: readme(GREETING),
  [`${SOLUTION}/greeting.ts`]: "export function formatGreeting(name: string): string {\n  return `hello ${name}`;\n}\n",
};

// Each `pnpm ex` is a fresh tsx process, and `ex test` starts a Vitest as well.
const SPAWNS = { timeout: 60_000 };

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

function setup(extra: Record<string, string> = {}) {
  const { root, cleanup } = makeRepo({ ...FILES, ...extra });
  cleanups.push(cleanup);
  const path = (rel: string) => join(root, rel);
  return {
    root,
    run: exRunner(root, envWithoutVitest()),
    path,
    read: (rel: string) => readFileSync(path(rel), "utf8"),
  };
}

async function settled(job: SwapJob): Promise<SwapJob> {
  for (let i = 0; i < 1200 && getSwapJob(job.id, job.owner)?.state === "running"; i++) {
    await new Promise((done) => setTimeout(done, 50));
  }
  return getSwapJob(job.id, job.owner)!;
}

async function testRun(run: ReturnType<typeof exRunner>, step: string, target: "playground" | "problem" | "solution") {
  const events: TestEvent[] = [];
  await runTests(run, { step, target, emit: (event) => events.push(event) });
  return events;
}

describe("reading the course", () => {
  it("lists the steps with their progress, and counts the graded steps passed", () => {
    const { root } = setup({ ".ex/state.json": JSON.stringify({ active_step: "01.2", passed: ["01.2"] }) });
    const course = readCourse(root);
    expect(course).toMatchObject({ active: "01.2", passed: 1, total: 1 });
    expect(course.sections).toEqual([
      expect.objectContaining({
        id: "01",
        title: "Basics",
        steps: [
          expect.objectContaining({ id: "01.1", type: "guided", status: "not_started", passed: false }),
          expect.objectContaining({ id: "01.2", type: "graded", status: "active", passed: true }),
        ],
      }),
    ]);
  });

  it("reads a step: its README without frontmatter, the problem file's hints, its files, the lab and its neighbours", () => {
    const { root } = setup();
    const page = readStepPage(root, "01.2")!;
    expect(page.readme).toBe("# Greeting\n\n🐨 Write `formatGreeting`.");
    expect(page.files).toEqual(["greeting.ts"]);
    expect(page.hints).toEqual([
      {
        emoji: "👨‍💼",
        text: "Kestrel greets every visitor by name. A missing name reads as rude.",
        file: "greeting.ts",
        line: 1,
      },
      { emoji: "🐨", text: 'Return "hello " and the name.', file: "greeting.ts", line: 4 },
      { emoji: "💰", text: "A template literal.", file: "greeting.ts", line: 5 },
    ]);
    expect(page).toMatchObject({
      section: { id: "01", title: "Basics" },
      lab: "/labs/basics",
      previous: { id: "01.1", title: "Tour" },
      next: null,
    });
    expect(readStepPage(root, "09.9")).toBeNull();
  });

  it("reads a section's README and FINISHED", () => {
    const { root } = setup();
    expect(readSectionPage(root, "01")).toMatchObject({
      readme: "# Basics\n\nA **greeting** is what you say first.",
      finished: "# Done",
    });
    expect(readSectionPage(root, "02")).toBeNull();
  });
});

describe("switching steps through `pnpm ex`", SPAWNS, () => {
  it("starts a step and reports what ex did; a second swap meanwhile is refused", async () => {
    const { root, run, read } = setup();
    const job = startSwap(run, { command: "start", step: "01.2", owner: "leo" });
    expect(job).toMatchObject({ state: "running", command: "start", step: "01.2" });
    expect(() => startSwap(run, { command: "start", step: "01.1", owner: "leo" })).toThrow(WorkshopBusy);
    expect(await settled(job)).toMatchObject({
      state: "done",
      error: null,
      result: { step: "01.2", files: ["greeting.ts"], next: { lab: "http://localhost:3000/labs/basics" } },
    });
    expect(read("playground/greeting.ts")).toBe(PROBLEM_CODE);
    expect(getSwapJob(job.id, "someone-else"), "only the user who started a switch can poll it").toBeNull();
    expect(readCourse(root).active).toBe("01.2");
  });

  it("passes on ex's refusal to discard changes, and goes ahead with force", async () => {
    const { run, path, read } = setup();
    expect((await settled(startSwap(run, { command: "start", step: "01.2", owner: "leo" }))).state).toBe("done");
    writeFileSync(path("playground/greeting.ts"), "// my work\n");
    const refused = await settled(startSwap(run, { command: "start", step: "01.1", owner: "leo" }));
    expect(refused).toMatchObject({
      state: "failed",
      wouldDiscard: true,
      error: {
        error: "playground/ has changes to 01.2 that `pnpm ex start 01.1` would discard",
        detail: "`pnpm ex diff 01.2` shows them; `pnpm ex start 01.1 --force` discards them",
      },
    });
    expect(read("playground/greeting.ts")).toBe("// my work\n");
    const forced = await settled(startSwap(run, { command: "start", step: "01.1", force: true, owner: "leo" }));
    expect(forced).toMatchObject({ state: "done", force: true, result: { step: "01.1" } });
    expect(existsSync(path("playground/greeting.ts"))).toBe(false);
  });

  it("puts the solution in the playground, and diffs the playground against it", async () => {
    const { run, path } = setup();
    expect(await readDiff(run, "01.2")).toEqual({
      error: "step 01.2 isn't active (active: none)",
      detail: "run `pnpm ex start 01.2` first",
    });
    await settled(startSwap(run, { command: "start", step: "01.2", owner: "leo" }));
    const diff = await readDiff(run, "01.2");
    expect(diff).toMatchObject({ files: [{ path: "greeting.ts", changed: true }] });
    expect("files" in diff && diff.files[0]!.diff).toContain("+  return `hello ${name}`;");
    expect((await settled(startSwap(run, { command: "solution", step: "01.2", owner: "leo" }))).state).toBe("done");
    expect(await readDiff(run, "01.2")).toEqual({ files: [{ path: "greeting.ts", changed: false, diff: "" }] });
    writeFileSync(path("playground/greeting.ts"), "// gone\n");
    expect((await settled(startSwap(run, { command: "reset", step: "01.2", owner: "leo" }))).state).toBe("done");
    expect(await readDiff(run, "01.2")).toMatchObject({ files: [{ changed: true }] });
  });
});

describe("running tests through `pnpm ex test`", SPAWNS, () => {
  it("streams the tests as they're collected and end, then the whole run", async () => {
    const { run } = setup();
    const events = await testRun(run, "01.2", "problem");
    const file = `${PROBLEM}/greeting.test.ts`;
    expect(events[0]).toEqual({ type: "started", step: "01.2", target: "problem" });
    expect(events[1]).toEqual({
      type: "collected",
      nodeids: [`${file} > greets by name`, `${file} > is a function`],
    });
    const streamed = events.filter((event) => event.type === "test").map((event) => event.test);
    expect(streamed.map((test) => [test.nodeid, test.outcome, test.message]).sort()).toEqual([
      [`${file} > greets by name`, "failed", "Error: not written: x"],
      [`${file} > is a function`, "passed", null],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done", run: { step: "01.2", target: "problem", passed: false } });
    expect(await testRun(run, "01.2", "solution")).toContainEqual(
      expect.objectContaining({ type: "done", run: expect.objectContaining({ passed: true }) }),
    );
  });

  it("grades the playground and marks the step passed, and says why when it can't run", async () => {
    const { root, run } = setup();
    expect((await testRun(run, "01.2", "playground")).at(-1)).toEqual({
      type: "failed",
      error: { error: "step 01.2 isn't active (active: none)", detail: "run `pnpm ex start 01.2` first" },
    });
    await settled(startSwap(run, { command: "start", step: "01.2", owner: "leo" }));
    await settled(startSwap(run, { command: "solution", step: "01.2", owner: "leo" }));
    expect((await testRun(run, "01.2", "playground")).at(-1)).toMatchObject({ type: "done", run: { passed: true } });
    expect(readCourse(root)).toMatchObject({ active: "01.2", passed: 1 });
  });

  it("stops the run when the client goes away, and frees the lock", async () => {
    const { run } = setup();
    const abort = new AbortController();
    const events: TestEvent[] = [];
    await runTests(run, {
      step: "01.2",
      target: "problem",
      signal: abort.signal,
      emit: (event) => {
        events.push(event);
        if (event.type === "started") setTimeout(() => abort.abort(), 300);
      },
    });
    expect(events.map((event) => event.type)).not.toContain("done");
    const job = startSwap(run, { command: "start", step: "01.1", owner: "leo" });
    expect((await settled(job)).state).toBe("done");
  });
});
