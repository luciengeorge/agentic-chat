import type { ParseArgsOptionsConfig } from "node:util";

import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Step } from "./catalog";
import type { Checked, DrillDeps, Planted, Reset } from "./drill";
import type { Next } from "./list";
import type { SmokeTargets } from "./smoke";
import type { SlotSwitch, Switched } from "./switch";
import type { StepRun, Target, TestProgress } from "./testing";

import { SlotError } from "../../vite-plugins/learn-slots";
import { findStep } from "./catalog";
import { checkDrill, defaultDrillDeps, listDrills, plantDrill, resetDrill } from "./drill";
import { ExError } from "./errors";
import { runGate } from "./gate";
import { listSections, nextFor } from "./list";
import { compose, up } from "./services";
import { runChecks, smokeChecks, smokeTargets } from "./smoke";
import { readState } from "./state";
import { switchSlots } from "./switch";
import { TARGETS, runStepTests } from "./testing";
import {
  activate,
  deactivate,
  diffPlayground,
  fillPlayground,
  hasChanges,
  markPassed,
  requireActive,
} from "./workspace";

export type Io = { out(text: string): void; err(text: string): void };
export type Context = {
  root: string;
  io: Io;
  slotSwitch: SlotSwitch;
  json: boolean;
  smoke?: SmokeTargets;
  drills?: DrillDeps;
};
type Outcome = { payload: unknown; text: string; ok: boolean };
type Values = Record<string, string | boolean | undefined>;

type Command = {
  usage: string;
  summary: string;
  args?: string[];
  options?: ParseArgsOptionsConfig;
  run(context: Context, args: string[], values: Values): Promise<Outcome>;
};

const NEXT = [
  "pnpm dev              # the app, http://localhost:3000",
  "pnpm fake-workspace   # http://localhost:8100",
  "pnpm ex smoke         # then check the whole stack",
];

/** Refuses when playground/ holds changes to the active step (other than `step`) that `command` would discard. */
function refuseToDiscard(root: string, command: string, step: Step | null): void {
  const active = readState(root).activeStep;
  if (active === null || active === step?.id) return;
  let current: Step;
  try {
    current = findStep(root, active);
  } catch {
    return; // the active step is gone from exercises/; nothing to compare against
  }
  if (hasChanges(root, current)) {
    throw new ExError(
      `playground/ has changes to ${active} that \`pnpm ex ${command}\` would discard`,
      `\`pnpm ex diff ${active}\` shows them; \`pnpm ex ${command} --force\` discards them`,
    );
  }
}

function nextText(next: Next): string[] {
  return [
    "next:",
    `  read  ${next.readme}`,
    ...(next.test ? [`  test  ${next.test}`] : []),
    ...(next.lab ? [`  lab   ${next.lab}`] : []),
  ];
}

async function switchTo(context: Context, step: Step, { restart, force }: { restart: boolean; force: boolean }) {
  const { root } = context;
  const next = nextFor(root, step);
  if (!restart && readState(root).activeStep === step.id) {
    return {
      payload: { step: step.id, files: [], already_active: true, next },
      text: [`${step.id} is already active; \`pnpm ex reset ${step.id}\` starts it over`, ...nextText(next)].join("\n"),
      ok: true,
    };
  }
  if (!force) refuseToDiscard(root, `start ${step.id}`, step);
  const result = await switchSlots(context.slotSwitch, root, () => activate(root, step));
  return {
    payload: { step: step.id, already_active: false, ...result, next },
    text: [switchedText(`started ${step.id} ${step.title}`, result), ...nextText(next)].join("\n"),
    ok: true,
  };
}

const MARKS = { passed: "✓", failed: "✗", skipped: "-", error: "✗" } as const;

/** A test run, short: each failing test's name and the first lines of its message. */
function runText(run: StepRun, where: string): string {
  const count = (outcome: string) => run.tests.filter((test) => test.outcome === outcome).length;
  const [passed, failed, errors, skipped] = ["passed", "failed", "error", "skipped"].map(count);
  const total = run.tests.length - errors;
  const summary = run.passed
    ? `${run.step} against ${where}: passed, ${passed} of ${total} tests`
    : `${run.step} against ${where}: failed, ${failed + errors} of ${total} tests`;
  const lines = [`${summary}${skipped ? ` (${skipped} skipped)` : ""}`];
  for (const test of run.tests) {
    if (test.outcome !== "failed" && test.outcome !== "error") continue;
    const name = test.outcome === "error" ? `${test.nodeid} (could not run)` : test.nodeid.split(" > ").at(-1)!;
    const message = (test.message ?? "").split("\n\n")[0]!.split("\n").slice(0, 6);
    lines.push("", `✗ ${name}`, ...message.map((line) => `  ${line}`));
  }
  if (run.warnings.length) lines.push("", ...run.warnings.map((warning) => `warning: ${warning}`));
  return lines.join("\n");
}

function switchedText(title: string, result: Switched): string {
  const lines = [title, ...result.files.map((file) => `  playground/${file}`)];
  if (result.cancelled.length > 0) lines.push(`cancelled ${result.cancelled.length} open workflow run(s)`);
  if (result.restarted.length > 0) lines.push(`restarted the ${result.restarted.join(", ")}`);
  lines.push(...result.skipped.map((reason) => `skipped ${reason}`));
  return lines.join("\n");
}

function switchLines({
  cancelled,
  restarted,
  skipped,
}: {
  cancelled: string[];
  restarted: string[];
  skipped: string[];
}) {
  return [
    ...(cancelled.length ? [`cancelled ${cancelled.length} open workflow run(s)`] : []),
    ...(restarted.length ? [`restarted the ${restarted.join(", ")}`] : []),
    ...skipped.map((reason) => `skipped ${reason}`),
  ];
}

function plantedText(planted: Planted): string {
  return [
    `planted drill ${planted.drill}: ${planted.title}`,
    ...switchLines(planted),
    "",
    planted.symptom,
    "",
    "Find the cause and fix it, then run `pnpm ex drill check`. Restart `pnpm dev` after a code change, as a deploy",
    "would. `pnpm ex drill reset` puts everything back.",
    "Spoilers: src/core/drills/, scripts/ex/drill*.ts and .ex/ hold the answer, and the dev server's terminal may",
    "have just printed a reload line naming the file the drill changed. Clear that terminal before you start.",
  ].join("\n");
}

function checkedText(checked: Checked): string {
  const { test } = checked;
  const passedTests = test.tests.filter((t) => t.outcome === "passed").length;
  const lines = [
    `drill ${checked.drill}: ${checked.passed ? "fixed" : "not fixed yet"}`,
    checked.symptom.gone ? "✓ the symptom is gone" : "✗ the symptom is still there",
    ...checked.symptom.probes.filter((probe) => !probe.ok).map((probe) => `  ${probe.detail}`),
    test.passed
      ? `✓ the fault's test passes (${passedTests} of ${test.tests.length})`
      : `✗ the fault's test fails (${passedTests} of ${test.tests.length} pass)`,
  ];
  if (test.error)
    lines.push(
      ...test.error
        .split("\n")
        .slice(0, 6)
        .map((line) => `  ${line}`),
    );
  for (const result of test.tests) {
    if (result.outcome === "passed") continue;
    lines.push(
      `  ${result.outcome === "skipped" ? "-" : "✗"} ${result.name}${result.outcome === "skipped" ? " (skipped: is ParadeDB up?)" : ""}`,
    );
    if (result.message)
      lines.push(
        ...result.message
          .split("\n")
          .slice(0, 4)
          .map((line) => `      ${line}`),
      );
  }
  lines.push(...checked.warnings.map((warning) => `warning: ${warning}`));
  if (checked.passed) lines.push("", "`pnpm ex drill reset` puts the original code back before the next drill.");
  return lines.join("\n");
}

function resetText(reset: Reset): string {
  if (reset.drill === null) {
    return reset.restored
      ? [
          `no drill was planted; put back ${reset.restored} file(s) a drill had left hidden`,
          ...switchLines(reset),
        ].join("\n")
      : "no drill is planted";
  }
  const lines = [`reset drill ${reset.drill}`, ...switchLines(reset)];
  if (reset.failures.length) {
    lines.push(
      "the code is back, but some of the drill's data couldn't be undone:",
      ...reset.failures.map((failure) => `  ${failure}`),
      "fix that, then run `pnpm ex drill reset` again",
    );
  }
  return lines.join("\n");
}

const COMMANDS: Record<string, Command> = {
  list: {
    usage: "list [--all]",
    summary: "List sections and steps with your progress (--all includes hidden ones)",
    options: { all: { type: "boolean", default: false } },
    async run({ root }, _, { all }) {
      const sections = listSections(root, { all: !!all });
      const lines = sections.flatMap((section) => [
        `${section.id} ${section.title}`,
        ...section.steps.map((row) => `  ${row.id.padEnd(8)} ${row.title}  [${row.type}, ${row.status}]`),
      ]);
      return { payload: { sections }, text: lines.join("\n"), ok: true };
    },
  },
  start: {
    usage: "start <step> [--force]",
    summary: "Copy a step's problem files into playground/ and make it active (--force discards your changes)",
    args: ["step"],
    options: { force: { type: "boolean", default: false } },
    run: (context, [id], { force }) =>
      switchTo(context, findStep(context.root, id!), { restart: false, force: !!force }),
  },
  reset: {
    usage: "reset <step>",
    summary: "Throw away your playground changes and start the step over",
    args: ["step"],
    run: (context, [id]) => switchTo(context, findStep(context.root, id!), { restart: true, force: true }),
  },
  stop: {
    usage: "stop [--force]",
    summary:
      "Leave the active step: empty playground/ and run the app on the reference (--force discards your changes)",
    options: { force: { type: "boolean", default: false } },
    async run(context, _, { force }) {
      const { root } = context;
      const active = readState(root).activeStep;
      if (active === null) {
        return { payload: { step: null, removed: [] }, text: "no step is active", ok: true };
      }
      if (!force) refuseToDiscard(root, "stop", null);
      const { files, ...result } = await switchSlots(context.slotSwitch, root, () => deactivate(root));
      return {
        payload: { step: active, removed: files, ...result },
        text: switchedText(`stopped ${active}: no step is active, and the app runs the reference code`, {
          files: [],
          ...result,
        }),
        ok: true,
      };
    },
  },
  test: {
    usage: "test <step> [--target playground|problem|solution] [--progress]",
    summary:
      "Run a step's tests against your playground (or the problem or solution code); --progress reports each test as it ends",
    args: ["step"],
    options: { target: { type: "string", default: "playground" }, progress: { type: "boolean", default: false } },
    async run({ root, json, io }, [id], values) {
      const target = values.target as Target;
      if (!TARGETS.includes(target)) throw new ExError(`--target must be one of ${TARGETS.join(", ")}`);
      const step = findStep(root, id!);
      if (step.type !== "graded") throw new ExError(`${step.id} is a ${step.type} step; it has no tests`);
      if (target === "playground") requireActive(root, step);
      if (!json) io.out(`running ${step.id}'s tests...`);
      // With --json, one JSON line per event on stderr, so stdout keeps its one document.
      const onProgress = !values.progress
        ? undefined
        : json
          ? (event: TestProgress) => io.err(JSON.stringify(event))
          : (event: TestProgress) => {
              if (event.event === "test")
                io.out(`${MARKS[event.test.outcome]} ${event.test.nodeid.split(" > ").at(-1)}`);
            };
      const result = await runStepTests(root, step, target, { capture: true, onProgress });
      if (result.passed && target === "playground") markPassed(root, step);
      const where = target === "playground" ? "playground/" : `its ${target} code`;
      return { payload: result, text: runText(result, where), ok: result.passed };
    },
  },
  diff: {
    usage: "diff <step>",
    summary: "Show how your playground differs from the solution",
    args: ["step"],
    async run({ root }, [id]) {
      const step = findStep(root, id!);
      requireActive(root, step);
      const files = diffPlayground(root, step);
      return {
        payload: { step: step.id, files },
        text: files.map((f) => f.diff).join("") || "no differences",
        ok: true,
      };
    },
  },
  solution: {
    usage: "solution <step>",
    summary: "Replace your playground files with the solution",
    args: ["step"],
    async run(context, [id]) {
      const { root } = context;
      const step = findStep(root, id!);
      requireActive(root, step);
      const result = await switchSlots(context.slotSwitch, root, () => fillPlayground(root, step.solutionDir));
      return {
        payload: { step: step.id, ...result },
        text: switchedText(`copied the ${step.id} solution`, result),
        ok: true,
      };
    },
  },
  gate: {
    usage: "gate",
    summary: "Check every graded step: its tests fail on the problem code and pass on the solution",
    async run({ root }) {
      const results = await runGate(root);
      const passed = results.every((result) => result.passed);
      const lines = results.flatMap((result) => [
        `${result.passed ? "ok  " : "FAIL"} ${result.step}${result.passed ? "" : `  (${result.reasons.join("; ")})`}`,
        ...(result.passed ? [] : [result.problem, result.solution]).flatMap((run) =>
          (run?.tests ?? [])
            .filter(
              (test) => test.outcome === "error" || test.outcome === (run?.target === "problem" ? "passed" : "failed"),
            )
            .map(
              (test) => `    ${run?.target}: ${test.outcome} ${test.nodeid}${test.message ? `: ${test.message}` : ""}`,
            ),
        ),
      ]);
      return { payload: { passed, steps: results }, text: lines.join("\n") || "no graded steps", ok: passed };
    },
  },
  drill: {
    usage: "drill <id>|list|check|reset",
    summary:
      "Section 20: `drill <id>` plants a hidden fault and shows its symptom, `check` grades your fix, `reset` puts everything back",
    args: ["drill"],
    async run(context, [what]) {
      const { root, slotSwitch } = context;
      const deps = context.drills ?? defaultDrillDeps();
      if (what === "list") {
        const listed = listDrills(root, deps);
        const lines = listed.drills.map((row) => `  ${row.id.padEnd(12)} ${row.title}  [${row.status}]`);
        return { payload: listed, text: ["drills:", ...lines].join("\n"), ok: true };
      }
      if (what === "check") {
        const checked = await checkDrill(root, deps);
        return { payload: checked, text: checkedText(checked), ok: checked.passed };
      }
      if (what === "reset") {
        const { ok, ...reset } = await resetDrill(root, slotSwitch, deps);
        return { payload: reset, text: resetText(reset), ok };
      }
      const planted = await plantDrill(root, slotSwitch, deps, what!);
      return { payload: planted, text: plantedText(planted), ok: true };
    },
  },
  up: {
    usage: "up",
    summary: "Start ParadeDB in Docker Compose, apply the migrations and seed the world",
    async run({ root, json }) {
      const { services, seed } = await up(root, { capture: json });
      const text = [
        "ParadeDB is up, migrated and seeded. Then, each in its own terminal:",
        ...NEXT.map((n) => `  ${n}`),
      ];
      return { payload: { services, seed, next: NEXT }, text: text.join("\n"), ok: true };
    },
  },
  down: {
    usage: "down [--volumes]",
    summary: "Stop the Compose stack (--volumes also deletes the database)",
    options: { volumes: { type: "boolean", default: false } },
    async run({ root, json }, _, { volumes }) {
      await compose(root, ["down", ...(volumes ? ["--volumes"] : [])], { capture: json });
      return { payload: { stopped: true, volumes_removed: !!volumes }, text: "the stack is down", ok: true };
    },
  },
  smoke: {
    usage: "smoke",
    summary: "Check the running stack end to end",
    async run({ root, smoke }) {
      const checks = await runChecks(smokeChecks(root, smoke ?? smokeTargets(root)));
      const passed = checks.every((check) => check.passed);
      const lines = checks.map((c) => `${c.passed ? "ok  " : "FAIL"} ${c.name}${c.detail ? `  ${c.detail}` : ""}`);
      return { payload: { passed, checks }, text: lines.join("\n"), ok: passed };
    },
  },
};

function usage(): string {
  const width = Math.max(...Object.values(COMMANDS).map((command) => command.usage.length));
  return [
    "Usage: pnpm ex <command> [--json]",
    "",
    ...Object.values(COMMANDS).map((command) => `  ${command.usage.padEnd(width)}  ${command.summary}`),
    "",
    "Every command takes --json and prints machine-readable output.",
  ].join("\n");
}

function parse(argv: string[]): { name: string; command: Command; args: string[]; values: Values } {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (name === undefined) throw new ExError("no command given", usage());
  const command = COMMANDS[name];
  if (!command) throw new ExError(`unknown command "${name}"`, usage());
  const at = argv.indexOf(name);
  const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: { json: { type: "boolean", default: false }, ...command.options },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    throw new ExError((error as Error).message, `usage: pnpm ex ${command.usage}`);
  }
  const wanted = command.args ?? [];
  if (parsed.positionals.length !== wanted.length) {
    const problem = parsed.positionals.length < wanted.length ? `missing <${wanted.at(-1)}>` : "too many arguments";
    throw new ExError(`${name}: ${problem}`, `usage: pnpm ex ${command.usage}`);
  }
  return { name, command, args: parsed.positionals, values: parsed.values };
}

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/** Runs one `ex` command and returns its exit code. */
export async function main(argv: string[], context: Omit<Context, "json">): Promise<number> {
  const json = argv.includes("--json");
  const { io } = context;
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    io.out(usage());
    return 0;
  }
  try {
    const { command, args, values } = parse(argv);
    const { payload, text, ok } = await command.run({ ...context, json }, args, values);
    if (json) io.out(JSON.stringify(payload, null, 2));
    else if (text) io.out(text);
    return ok ? 0 : 1;
  } catch (error) {
    // Paths read better relative to the repo.
    const short = (text: string) => text.replaceAll(`${context.root}/`, "");
    const known = error instanceof ExError || error instanceof SlotError;
    const message = short(error instanceof Error ? error.message : String(error));
    const raw = error instanceof ExError ? error.detail : known ? null : ((error as Error).stack ?? null);
    const detail = typeof raw === "string" ? short(raw) : raw;
    if (json) io.out(JSON.stringify({ error: message, detail }, null, 2));
    else {
      io.err(`error: ${message}`);
      if (detail !== null) io.err(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
    }
    return 1;
  }
}
