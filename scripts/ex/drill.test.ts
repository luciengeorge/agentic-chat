// @vitest-environment node
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Action, DrillEntry, Fault, Need, Probe } from "@/core/drills/types";

import { seal } from "@/core/drills/seal";

import type { DrillDeps, Live, Vars } from "./drill";
import type { SlotSwitch } from "./switch";

import { main } from "./cli";
import { CHECK_DIR, JOURNAL, runDrillTest } from "./drill";
import { commitAll, gitIn } from "./drill-testing";
import { makeRepo, readme } from "./test-repo";

const THING = "src/core/demo/thing.ts";
const ORIGINAL = "export const answer = (): number => 42;\n";

const FAULT: Fault = {
  symptom: "At {{planted}} the answer went wrong for {{tenant kestrel}}.",
  cause: "41",
  clues: ["look at the answer"],
  modules: ["demo/thing"],
  needs: ["database"],
  requires: [{ text: "REQUIRE {{tenant kestrel}}", explain: "it needs kestrel" }],
  files: [{ path: THING, edits: [{ find: "42", replace: "41" }] }],
  plant: [{ kind: "sql", text: "PLANT {{tenant kestrel}}" }],
  undo: [{ kind: "sql", text: "UNDO {{tenant kestrel}}" }],
  probes: [{ kind: "sql-none", text: "PROBE {{tenant kestrel}}", explain: "the answer is still wrong" }],
  test: `import { expect, test } from "vitest";
import { answer } from "#learn/demo/thing";

test("answers 42", () => {
  expect(answer()).toBe(42);
});
`,
};
const DRILL: DrillEntry = { id: "demo", title: "The answer is wrong", sealed: seal("demo", FAULT) };

const STEP = { title: "Thing", type: "graded", slots: { "demo/thing": "thing.ts" } };
const FILES = {
  ".gitignore": ".ex/\nnode_modules\n",
  [THING]: ORIGINAL,
  "src/core/other.ts": "export const other = 1;\n",
  [`${CHECK_DIR}/.gitignore`]: "*\n!.gitignore\n",
  "exercises/01.demo/README.md": readme({ title: "Demo" }),
  "exercises/01.demo/01.problem.thing/README.md": readme(STEP),
  "exercises/01.demo/01.problem.thing/thing.ts": ORIGINAL,
  "exercises/01.demo/01.solution.thing/README.md": readme(STEP),
  "exercises/01.demo/01.solution.thing/thing.ts": ORIGINAL,
  "exercises/01.demo/02.problem.other/README.md": readme({ title: "Other", type: "guided" }),
  "exercises/01.demo/02.solution.other/README.md": readme({ title: "Other", type: "guided" }),
};

/** The stack as the drill sees it, recorded. */
class FakeLive implements Live {
  calls: string[] = [];
  rows = 1;
  probeOk = false;
  failOn: string | null = null;
  closed = 0;

  async preflight(needs: readonly Need[]) {
    this.calls.push(`preflight ${needs.join(",")}`);
  }
  async resolve(names: readonly string[], vars: Vars) {
    for (const name of names) if (name === "tenant kestrel") vars[name] ??= "t-1";
  }
  async count(sql: string) {
    this.calls.push(sql);
    return this.rows;
  }
  async act(action: Action) {
    const text = action.kind === "sql" ? action.text : action.kind;
    if (this.failOn && text.startsWith(this.failOn)) throw new Error(`${this.failOn} failed`);
    this.calls.push(text);
  }
  async probe(probe: Probe) {
    this.calls.push(probe.kind === "sql-none" ? probe.text : probe.kind);
    return { ok: this.probeOk, detail: this.probeOk ? "" : probe.explain };
  }
  async close() {
    this.closed++;
  }
}

class FakeSwitch implements SlotSwitch {
  events: string[] = [];
  pauseError: Error | null = null;
  constructor(private readonly root: string) {}
  private thing() {
    const text = readFileSync(join(this.root, THING), "utf8");
    return text === ORIGINAL ? "original" : text.includes("41") ? "faulty" : "other";
  }
  async pauseDevServer() {
    if (this.pauseError) throw this.pauseError;
    this.events.push(`pause ${this.thing()}`);
    return { open: 0, restart: async () => void this.events.push(`restart ${this.thing()}`) };
  }
  async cancelOpenRuns() {
    this.events.push("cancel");
    return [];
  }
}

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups = [];
});

const SPAWNS_VITEST = { timeout: 30_000 };

function setup() {
  const { root, cleanup } = makeRepo(FILES);
  cleanups.push(cleanup);
  commitAll(root);
  const live = new FakeLive();
  const slotSwitch = new FakeSwitch(root);
  const deps: DrillDeps = {
    drills: [DRILL],
    live: () => live,
    runTest: (r, id, source) => runDrillTest(r, id, source, { project: null }),
    now: () => new Date(2026, 9, 20, 9, 15),
  };
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  async function ex(args: string[], { ok = true } = {}) {
    let out = "";
    const code = await main([...args, "--json"], {
      root,
      io: { out: (text) => (out += `${text}\n`), err: (text) => (out += `${text}\n`) },
      slotSwitch,
      drills: deps,
    });
    expect(code === 0, `exit ${code}\n${out}`).toBe(ok);
    return JSON.parse(out);
  }
  async function text(args: string[]) {
    let out = "";
    await main(args, {
      root,
      io: { out: (t) => (out += `${t}\n`), err: (t) => (out += `${t}\n`) },
      slotSwitch,
      drills: deps,
    });
    return out;
  }
  return { root, live, slotSwitch, read, ex, text };
}

describe("ex drill", () => {
  it("lists the drills with their status", async () => {
    const { ex } = setup();
    expect(await ex(["drill", "list"])).toEqual({
      active: null,
      drills: [{ id: "demo", title: "The answer is wrong", status: "not_started" }],
    });
  });

  it("plants the fault with the dev server paused, prints only the symptom, and git sees nothing", async () => {
    const { root, live, slotSwitch, read, ex, text } = setup();
    const before = Math.round(statSync(join(root, THING)).mtimeMs);
    const planted = await ex(["drill", "demo"]);
    expect(planted).toEqual({
      drill: "demo",
      title: "The answer is wrong",
      symptom: "At 09:15 the answer went wrong for t-1.",
      cancelled: [],
      restarted: ["dev server"],
      skipped: [],
    });
    expect(read(THING)).toBe("export const answer = (): number => 41;\n");
    expect(slotSwitch.events).toEqual(["pause original", "cancel", "restart faulty"]);
    expect(live.calls).toEqual(["preflight database", "REQUIRE 't-1'", "PLANT 't-1'"]);
    expect(live.closed).toBe(1);

    expect(gitIn(root, ["status", "--porcelain"])).toBe("");
    expect(gitIn(root, ["diff", "HEAD"])).toBe("");
    expect(Math.round(statSync(join(root, THING)).mtimeMs)).toBe(before);
    expect(gitIn(root, ["ls-files", "-v", THING])).toBe(`S ${THING}\n`);
    // Nor do the journal or the printed output name the file.
    expect(read(JOURNAL)).not.toContain("thing");
    expect(JSON.stringify(planted)).not.toContain("thing");
    expect(await text(["drill", "reset"])).not.toContain("thing");

    expect((await ex(["drill", "list"])).active).toBeNull();
  });

  it("refuses a second drill while one is planted", async () => {
    const { ex } = setup();
    await ex(["drill", "demo"]);
    expect((await ex(["drill", "demo"], { ok: false })).error).toBe("drill demo is planted");
    expect((await ex(["drill", "list"])).drills[0].status).toBe("active");
  });

  it(
    "checks by behaviour: the symptom must be gone and the fault's test pass, and a pass is remembered",
    SPAWNS_VITEST,
    async () => {
      const { root, live, read, ex } = setup();
      await ex(["drill", "demo"]);
      const failing = await ex(["drill", "check"], { ok: false });
      expect(failing.passed).toBe(false);
      expect(failing.symptom).toEqual({ gone: false, probes: [{ ok: false, detail: "the answer is still wrong" }] });
      expect(failing.test.passed).toBe(false);
      expect(failing.test.tests).toEqual([
        { name: "answers 42", outcome: "failed", message: expect.stringContaining("expected 41 to be 42") },
      ]);
      expect(live.calls.at(-1)).toBe("PROBE 't-1'");
      expect(existsSync(join(root, CHECK_DIR, "demo.test.ts")), "the test file is deleted after the run").toBe(false);

      // The learner's fix, and their repair of the data.
      writeFileSync(join(root, THING), read(THING).replace("41", "42"));
      live.probeOk = true;
      const fixed = await ex(["drill", "check"]);
      expect(fixed.passed).toBe(true);
      expect(fixed.test).toEqual({
        passed: true,
        tests: [{ name: "answers 42", outcome: "passed", message: null }],
        error: null,
      });
      expect((await ex(["drill", "list"])).drills[0].status).toBe("active");
      await ex(["drill", "reset"]);
      expect((await ex(["drill", "list"])).drills[0].status).toBe("passed");
    },
  );

  it("resets: the original file and its time, git sees it again, the data undone with the plant's values", async () => {
    const { root, live, slotSwitch, read, ex } = setup();
    const before = Math.round(statSync(join(root, THING)).mtimeMs);
    await ex(["drill", "demo"]);
    writeFileSync(join(root, THING), "a learner's half fix\n");
    slotSwitch.events = [];
    expect(await ex(["drill", "reset"])).toEqual({
      drill: "demo",
      restored: 1,
      undone: 1,
      failures: [],
      cancelled: [],
      restarted: ["dev server"],
      skipped: [],
    });
    expect(read(THING)).toBe(ORIGINAL);
    expect(Math.round(statSync(join(root, THING)).mtimeMs)).toBe(before);
    expect(gitIn(root, ["ls-files", "-v", THING])).toBe(`H ${THING}\n`);
    expect(slotSwitch.events).toEqual(["pause other", "cancel", "restart original"]);
    expect(live.calls.at(-1)).toBe("UNDO 't-1'");
    expect(await ex(["drill", "reset"])).toMatchObject({ drill: null, restored: 0 });
    expect(await ex(["drill", "check"], { ok: false })).toMatchObject({ error: "no drill is planted" });
  });

  it("refuses to plant over uncommitted changes, without naming the file", async () => {
    const { root, read, ex } = setup();
    writeFileSync(join(root, THING), "export const answer = (): number => 43;\n");
    const refused = await ex(["drill", "demo"], { ok: false });
    expect(refused.error).toBe(
      "a file this drill plants its fault in has uncommitted changes, or git doesn't track it",
    );
    expect(JSON.stringify(refused)).not.toContain("thing");
    expect(read(THING)).toContain("43");
    expect(existsSync(join(root, JOURNAL))).toBe(false);
  });

  it("refuses while the active step slots the code the fault is in, without naming it, and allows another step", async () => {
    const { root, ex } = setup();
    mkdirSync(join(root, ".ex"));
    writeFileSync(join(root, ".ex/state.json"), JSON.stringify({ active_step: "01.1", passed: [] }));
    const refused = await ex(["drill", "demo"], { ok: false });
    expect(refused.error).toBe(
      "a step in your playground slots code this drill changes; run `pnpm ex stop`, then plant",
    );
    expect(JSON.stringify(refused), "naming the step would narrow down where the fault is").not.toContain("01.1");
    writeFileSync(join(root, ".ex/state.json"), JSON.stringify({ active_step: "01.2", passed: [] }));
    await ex(["drill", "demo"]);
    writeFileSync(join(root, ".ex/state.json"), JSON.stringify({ active_step: "01.1", passed: [] }));
    const checked = await ex(["drill", "check"], { ok: false });
    expect(checked.warnings).toEqual([
      "a step in your playground slots code this drill uses, so the app runs your playground, not the code the drill changed",
    ]);
  });

  it("refuses when the stack isn't in the state the drill plants into, before changing anything", async () => {
    const { root, live, read, ex } = setup();
    live.rows = 0;
    expect((await ex(["drill", "demo"], { ok: false })).error).toBe("can't plant demo: it needs kestrel");
    expect(read(THING)).toBe(ORIGINAL);
    expect(existsSync(join(root, JOURNAL))).toBe(false);
  });

  it("refuses a drill whose edits no longer apply", async () => {
    const { root, ex } = setup();
    writeFileSync(join(root, THING), "export const answer = (): number => 7;\n");
    gitIn(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qam", "seven"]);
    expect((await ex(["drill", "demo"], { ok: false })).error).toBe("drill demo no longer applies to this code");
  });

  it("changes nothing when the dev server can't be paused", async () => {
    const { root, slotSwitch, read, ex } = setup();
    slotSwitch.pauseError = new Error("it's restarting");
    expect((await ex(["drill", "demo"], { ok: false })).error).toContain("couldn't pause the dev server");
    expect(read(THING)).toBe(ORIGINAL);
    expect(gitIn(root, ["ls-files", "-v", THING])).toBe(`H ${THING}\n`);
    expect((await ex(["drill", "list"])).active).toBeNull();
  });

  it("restores after a plant that failed partway", async () => {
    const { live, read, ex } = setup();
    live.failOn = "PLANT";
    const failed = await ex(["drill", "demo"], { ok: false });
    expect(failed.error).toBe("planting drill demo failed partway");
    expect(failed.detail).toContain("`pnpm ex drill reset` puts everything back");
    expect((await ex(["drill", "check"], { ok: false })).error).toBe("drill demo didn't finish planting");
    live.failOn = null;
    expect(await ex(["drill", "reset"])).toMatchObject({ drill: "demo", restored: 1, undone: 1 });
    expect(read(THING)).toBe(ORIGINAL);
  });

  it("restores a fault even when its journal is gone", async () => {
    const { root, read, ex } = setup();
    await ex(["drill", "demo"]);
    rmSync(join(root, JOURNAL));
    expect(await ex(["drill", "reset"])).toMatchObject({ drill: null, restored: 1 });
    expect(read(THING)).toBe(ORIGINAL);
    expect(gitIn(root, ["ls-files", "-v", THING])).toBe(`H ${THING}\n`);
  });

  it("keeps the journal when an undo fails, so reset can be run again", async () => {
    const { live, read, ex } = setup();
    await ex(["drill", "demo"]);
    live.failOn = "UNDO";
    const partial = await ex(["drill", "reset"], { ok: false });
    expect(partial).toMatchObject({ drill: "demo", restored: 1, undone: 0, failures: ["UNDO failed"] });
    expect(read(THING)).toBe(ORIGINAL);
    live.failOn = null;
    expect(await ex(["drill", "reset"])).toMatchObject({ drill: "demo", restored: 0, undone: 1, failures: [] });
    expect(await ex(["drill", "reset"])).toMatchObject({ drill: null });
  });

  it("says what to do with an unknown drill or none", async () => {
    const { ex } = setup();
    expect(await ex(["drill", "nope"], { ok: false })).toEqual({
      error: "no drill nope",
      detail: "`pnpm ex drill list` shows them",
    });
    expect((await ex(["drill"], { ok: false })).error).toBe("drill: missing <drill>");
  });
});
