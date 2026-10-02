import type { ParseArgsOptionsConfig } from "node:util";

import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import type { Step } from "./catalog";
import type { SmokeTargets } from "./smoke";
import type { SlotSwitch, Switched } from "./switch";
import type { Target } from "./testing";

import { SlotError } from "../../vite-plugins/learn-slots";
import { findStep, loadCatalog } from "./catalog";
import { ExError } from "./errors";
import { runGate } from "./gate";
import { compose, up } from "./services";
import { runChecks, smokeChecks, smokeTargets } from "./smoke";
import { readState } from "./state";
import { switchSlots } from "./switch";
import { TARGETS, runStepTests } from "./testing";
import { activate, diffPlayground, fillPlayground, hasChanges, markPassed, requireActive } from "./workspace";

export type Io = { out(text: string): void; err(text: string): void };
export type Context = { root: string; io: Io; slotSwitch: SlotSwitch; json: boolean; smoke?: SmokeTargets };
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

function stepJson(step: Step, root: string, state: { activeStep: string | null; passed: string[] }) {
  const status = step.id === state.activeStep ? "active" : state.passed.includes(step.id) ? "passed" : "not_started";
  return {
    id: step.id,
    slug: step.slug,
    title: step.title,
    type: step.type,
    problem_dir: relative(root, step.problemDir),
    solution_dir: relative(root, step.solutionDir),
    status,
  };
}

function refuseToDiscard(root: string, step: Step): void {
  const active = readState(root).activeStep;
  if (active === null || active === step.id) return;
  let current: Step;
  try {
    current = findStep(root, active);
  } catch {
    return; // the active step is gone from exercises/; nothing to compare against
  }
  if (hasChanges(root, current)) {
    throw new ExError(
      `playground/ has changes to ${active} that \`pnpm ex start ${step.id}\` would discard`,
      `\`pnpm ex diff ${active}\` shows them; \`pnpm ex start ${step.id} --force\` discards them`,
    );
  }
}

async function switchTo(context: Context, step: Step, { restart, force }: { restart: boolean; force: boolean }) {
  const { root } = context;
  if (!restart && readState(root).activeStep === step.id) {
    return {
      payload: { step: step.id, files: [], already_active: true },
      text: `${step.id} is already active; \`pnpm ex reset ${step.id}\` starts it over`,
      ok: true,
    };
  }
  if (!force) refuseToDiscard(root, step);
  const result = await switchSlots(context.slotSwitch, root, () => activate(root, step));
  return {
    payload: { step: step.id, already_active: false, ...result },
    text: switchedText(`started ${step.id} ${step.title}`, result),
    ok: true,
  };
}

function switchedText(title: string, result: Switched): string {
  const lines = [title, ...result.files.map((file) => `  playground/${file}`)];
  if (result.cancelled.length > 0) lines.push(`cancelled ${result.cancelled.length} open workflow run(s)`);
  if (result.restarted.length > 0) lines.push(`restarted the ${result.restarted.join(", ")}`);
  lines.push(...result.skipped.map((reason) => `skipped ${reason}`));
  return lines.join("\n");
}

const COMMANDS: Record<string, Command> = {
  list: {
    usage: "list [--all]",
    summary: "List sections and steps with your progress (--all includes hidden ones)",
    options: { all: { type: "boolean", default: false } },
    async run({ root }, _, { all }) {
      const state = readState(root);
      const sections = [];
      const lines: string[] = [];
      for (const section of loadCatalog(root)) {
        const steps = section.steps.filter((step) => all || !step.hidden);
        if ((section.hidden && !all) || steps.length === 0) continue;
        const rows = steps.map((step) => stepJson(step, root, state));
        sections.push({
          id: section.id,
          slug: section.slug,
          title: section.title,
          hidden: section.hidden,
          steps: rows,
        });
        lines.push(`${section.id} ${section.title}`);
        lines.push(...rows.map((row) => `  ${row.id.padEnd(8)} ${row.title}  [${row.type}, ${row.status}]`));
      }
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
  test: {
    usage: "test <step> [--target playground|problem|solution]",
    summary: "Run a step's tests against your playground (or the problem or solution code)",
    args: ["step"],
    options: { target: { type: "string", default: "playground" } },
    async run({ root, json }, [id], values) {
      const target = values.target as Target;
      if (!TARGETS.includes(target)) throw new ExError(`--target must be one of ${TARGETS.join(", ")}`);
      const step = findStep(root, id!);
      if (step.type !== "graded") throw new ExError(`${step.id} is a ${step.type} step; it has no tests`);
      if (target === "playground") requireActive(root, step);
      const result = await runStepTests(root, step, target, { capture: json });
      if (result.passed && target === "playground") markPassed(root, step);
      return { payload: result, text: `${step.id}: ${result.passed ? "passed" : "failed"}`, ok: result.passed };
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
