/**
 * `pnpm ex drill` (section 20): plants one hidden fault in the running app, grades the fix by behaviour, and puts
 * everything back.
 *
 * How a fault hides. Its edits, its data changes, its checks and its test are sealed (`src/core/drills/seal.ts`).
 * Planting writes the edits into tracked files while the dev server is paused, gives each file back its old
 * modification time, and marks it `git update-index --skip-worktree`, so `git status`, `git diff`, `git diff HEAD`
 * and an editor's change markers show nothing, and `git add -A` can't commit the fault. The journal that lets
 * `reset` undo it all is sealed too, in `.ex/drill.json`. None of this stops someone who goes looking:
 * `git ls-files -v` prints an `S` beside the file, its ctime moved, and a hash of each file against `git ls-files -s`
 * finds it. It stops the accidental spoiler, which is the one that matters for practice.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Action, DrillEntry, Edit, Fault, Need, Probe } from "@/core/drills/types";

import { DRILLS } from "@/core/drills/catalog";
import { seal, unseal } from "@/core/drills/seal";

import type { SlotSwitch } from "./switch";

import { NO_STEP } from "../../vite-plugins/learn-slots";
import { findStep } from "./catalog";
import { localEnv } from "./env";
import { ExError } from "./errors";
import { readState } from "./state";
import { switchSlots } from "./switch";

export const JOURNAL = ".ex/drill.json";
/** Where `check` writes a fault's test while it runs. Its .gitignore keeps whatever a crash leaves behind out of git. */
export const CHECK_DIR = "src/core/drills/check";

export type Vars = Record<string, string>;
export type ProbeResult = { ok: boolean; detail: string };

/** The running stack, as a drill sees it (`./drill-live.ts`). */
export interface Live {
  /** Throws an ExError naming what's missing. */
  preflight(needs: readonly Need[]): Promise<void>;
  /** Adds a value to `vars` for each `{{...}}` name it doesn't hold yet. */
  resolve(names: readonly string[], vars: Vars): Promise<void>;
  /** The number of rows a query returns, as the database's owner. */
  count(sql: string): Promise<number>;
  act(action: Action): Promise<void>;
  probe(probe: Probe): Promise<ProbeResult>;
  close(): Promise<void>;
}

export type DrillTestResult = { name: string; outcome: "passed" | "failed" | "skipped"; message: string | null };
export type DrillTest = { passed: boolean; tests: DrillTestResult[]; error: string | null };

export type DrillDeps = {
  drills: DrillEntry[];
  live(root: string): Live;
  runTest(root: string, id: string, source: string): Promise<DrillTest>;
  now(): Date;
};

type Saved = { path: string; original: string; atimeMs: number; mtimeMs: number };
type Active = { id: string; phase: "planting" | "planted" | "undoing"; plantedAt: string; vars: Vars; files: Saved[] };
type Journal = { active: Active | null; passed: string[] };

const JOURNAL_SEAL = "journal";

export function readJournal(root: string): Journal {
  const path = join(root, JOURNAL);
  if (!existsSync(path)) return { active: null, passed: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { active: string | null; passed?: string[] };
    return { active: data.active ? unseal<Active>(JOURNAL_SEAL, data.active) : null, passed: data.passed ?? [] };
  } catch {
    throw new ExError(`${JOURNAL} can't be read`, "`pnpm ex drill reset` repairs what it can find without it");
  }
}

function writeJournal(root: string, journal: Journal): void {
  const path = join(root, JOURNAL);
  mkdirSync(dirname(path), { recursive: true });
  const body = { active: journal.active ? seal(JOURNAL_SEAL, journal.active) : null, passed: journal.passed };
  writeFileSync(`${path}.tmp`, `${JSON.stringify(body, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

function git(root: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new ExError(`git ${args.join(" ")} failed`, stderr || String(error));
  }
}

/** `git ls-files -v`'s tag: H tracked, S skip-worktree, h assume-unchanged, "" untracked. */
function gitTag(root: string, path: string): string {
  return git(root, ["ls-files", "-v", "--", path]).slice(0, 1);
}

/** Replaces each edit's `find`, which must occur exactly once. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const { find, replace } of edits) {
    const at = out.indexOf(find);
    if (at === -1 || out.indexOf(find, at + 1) !== -1)
      throw new Error("an edit no longer matches its file exactly once");
    out = out.slice(0, at) + replace + out.slice(at + find.length);
  }
  return out;
}

type Prepared = { saved: Saved; patched: string };

/** Each file the fault changes: what it holds now, and what it will hold. Throws if an edit doesn't apply. */
export function prepareFiles(root: string, fault: Fault): Prepared[] {
  return fault.files.map(({ path, edits }) => {
    const file = join(root, path);
    const original = readFileSync(file, "utf8");
    const { atimeMs, mtimeMs } = statSync(file);
    return { saved: { path, original, atimeMs, mtimeMs }, patched: applyEdits(original, edits) };
  });
}

/** Writes the faults in, keeps each file's old times, and hides the change from git. */
export function writeFaults(root: string, prepared: readonly Prepared[]): void {
  for (const { saved, patched } of prepared) {
    const file = join(root, saved.path);
    writeFileSync(file, patched);
    utimesSync(file, saved.atimeMs / 1000, saved.mtimeMs / 1000);
    git(root, ["update-index", "--skip-worktree", "--", saved.path]);
  }
}

/** Puts each file back as it was, with its old times, and lets git see it again. */
export function restoreFiles(root: string, saved: readonly Saved[]): void {
  for (const { path, original, atimeMs, mtimeMs } of saved) {
    const file = join(root, path);
    if (!existsSync(file) || readFileSync(file, "utf8") !== original) writeFileSync(file, original);
    utimesSync(file, atimeMs / 1000, mtimeMs / 1000);
    if (gitTag(root, path) === "S") git(root, ["update-index", "--no-skip-worktree", "--", path]);
  }
}

const TOKEN = /\{\{([^{}]+)\}\}/g;

/** The `{{...}}` names a fault uses anywhere. */
export function varNames(fault: Fault): string[] {
  return [...new Set([...JSON.stringify(fault).matchAll(TOKEN)].map((match) => match[1]!.trim()))];
}

/** `text` with each `{{name}}` replaced; in `sql`, as a quoted literal. */
export function fill(text: string, vars: Vars, mode: "sql" | "text"): string {
  return text.replace(TOKEN, (_, raw: string) => {
    const value = vars[raw.trim()];
    if (value === undefined) throw new Error(`no value for {{${raw.trim()}}}`);
    return mode === "sql" ? `'${value.replaceAll("'", "''")}'` : value;
  });
}

export const fillAction = (action: Action, vars: Vars): Action =>
  action.kind === "sql" ? { ...action, text: fill(action.text, vars, "sql") } : action;

export function fillProbe(probe: Probe, vars: Vars): Probe {
  const explain = fill(probe.explain, vars, "text");
  return probe.kind === "sql-none" ? { ...probe, explain, text: fill(probe.text, vars, "sql") } : { ...probe, explain };
}

function findDrill(deps: DrillDeps, id: string): DrillEntry {
  const drill = deps.drills.find((candidate) => candidate.id === id);
  if (!drill) throw new ExError(`no drill ${id}`, "`pnpm ex drill list` shows them");
  return drill;
}

/** The active step, when it slots code the fault lives in: the app would run the playground, not the fault. */
function conflictingStep(root: string, fault: Fault): string | null {
  const active = readState(root).activeStep;
  if (active === null || fault.modules.length === 0) return null;
  try {
    const step = findStep(root, active);
    return fault.modules.some((module) => module in step.slots) ? step.id : null;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (error instanceof ExError) return error.detail ? `${error.message}: ${String(error.detail)}` : error.message;
  return error instanceof Error ? error.message : String(error);
}

export type SwitchReport = { cancelled: string[]; restarted: string[]; skipped: string[] };
const NOTHING_SWITCHED: SwitchReport = { cancelled: [], restarted: [], skipped: [] };

async function swap(slotSwitch: SlotSwitch, root: string, change: () => void): Promise<SwitchReport> {
  const { cancelled, restarted, skipped } = await switchSlots(slotSwitch, root, () => {
    change();
    return [];
  });
  return { cancelled, restarted, skipped };
}

export type Planted = SwitchReport & { drill: string; title: string; symptom: string };

export async function plantDrill(root: string, slotSwitch: SlotSwitch, deps: DrillDeps, id: string): Promise<Planted> {
  const drill = findDrill(deps, id);
  const journal = readJournal(root);
  if (journal.active) {
    throw new ExError(
      `drill ${journal.active.id} is planted`,
      "`pnpm ex drill reset` puts it back; then plant another",
    );
  }
  const fault = unseal<Fault>(drill.id, drill.sealed);
  const step = conflictingStep(root, fault);
  if (step) {
    throw new ExError(
      `the active step ${step} slots code this drill plants its fault in, so the app wouldn't run the fault`,
      "`pnpm ex stop` leaves the step (it refuses while your playground has changes), or pick another drill",
    );
  }
  git(root, ["rev-parse", "--is-inside-work-tree"]);
  for (const { path } of fault.files) {
    const tag = gitTag(root, path);
    if (tag !== "H" || git(root, ["status", "--porcelain", "--", path]).trim() !== "") {
      throw new ExError(
        "a file this drill plants its fault in has uncommitted changes, or git doesn't track it",
        "commit or stash your changes (`git status` shows them), then plant again",
      );
    }
  }
  let prepared: Prepared[];
  try {
    prepared = prepareFiles(root, fault);
  } catch (error) {
    throw new ExError(
      `drill ${id} no longer applies to this code`,
      `${describe(error)}; its fault needs re-making (scripts/ex/drill-seal.ts)`,
    );
  }

  const live = deps.live(root);
  try {
    await live.preflight(fault.needs);
    const vars: Vars = { planted: deps.now().toTimeString().slice(0, 5) };
    await live.resolve(varNames(fault), vars);
    for (const requirement of fault.requires) {
      if ((await live.count(fill(requirement.text, vars, "sql"))) === 0) {
        throw new ExError(`can't plant ${id}: ${fill(requirement.explain, vars, "text")}`);
      }
    }
    const saved = prepared.map((file) => file.saved);
    const active: Active = { id, phase: "planting", plantedAt: deps.now().toISOString(), vars, files: saved };
    writeJournal(root, { ...journal, active });
    let switched: SwitchReport;
    try {
      switched = await swap(slotSwitch, root, () => writeFaults(root, prepared));
    } catch (error) {
      // Nothing ran on the fault: put back what got written, and forget the drill.
      try {
        restoreFiles(root, saved);
        writeJournal(root, { ...journal, active: null });
      } catch {
        // The journal still holds the originals; `reset` restores them.
      }
      throw error;
    }
    for (const action of fault.plant) {
      try {
        await live.act(fillAction(action, vars));
      } catch (error) {
        throw new ExError(
          `planting drill ${id} failed partway`,
          `${describe(error)}\n\`pnpm ex drill reset\` puts everything back`,
        );
      }
    }
    writeJournal(root, { ...journal, active: { ...active, phase: "planted" } });
    return { drill: id, title: drill.title, symptom: fill(fault.symptom, vars, "text"), ...switched };
  } finally {
    await live.close();
  }
}

export type Checked = {
  drill: string;
  passed: boolean;
  symptom: { gone: boolean; probes: ProbeResult[] };
  test: DrillTest;
  warnings: string[];
};

export async function checkDrill(root: string, deps: DrillDeps): Promise<Checked> {
  const journal = readJournal(root);
  const active = journal.active;
  if (!active)
    throw new ExError("no drill is planted", "`pnpm ex drill list` shows them; `pnpm ex drill <id>` plants one");
  if (active.phase !== "planted") {
    throw new ExError(
      `drill ${active.id} didn't finish ${active.phase === "planting" ? "planting" : "resetting"}`,
      "`pnpm ex drill reset` puts everything back",
    );
  }
  const fault = unseal<Fault>(active.id, findDrill(deps, active.id).sealed);
  const warnings: string[] = [];
  const step = conflictingStep(root, fault);
  if (step)
    warnings.push(
      `the active step ${step} slots code this drill uses, so the app runs your playground, not the code the drill changed`,
    );

  const live = deps.live(root);
  const probes: ProbeResult[] = [];
  try {
    for (const probe of fault.probes) {
      const filled = fillProbe(probe, active.vars);
      probes.push(
        await live
          .probe(filled)
          .catch((error: unknown) => ({ ok: false, detail: `${filled.explain} (${describe(error)})` })),
      );
    }
  } finally {
    await live.close();
  }
  const test = await deps.runTest(root, active.id, fault.test);
  const gone = probes.every((probe) => probe.ok);
  const passed = gone && test.passed;
  if (passed && !journal.passed.includes(active.id)) {
    writeJournal(root, { ...journal, passed: [...journal.passed, active.id].sort() });
  }
  return { drill: active.id, passed, symptom: { gone, probes }, test, warnings };
}

export type Reset = SwitchReport & { drill: string | null; restored: number; undone: number; failures: string[] };

/** Removes whatever `check` left in its folder: a test file a crash didn't delete. */
function cleanCheckDir(root: string): void {
  const dir = join(root, CHECK_DIR);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir))
    if (name !== ".gitignore") rmSync(join(dir, name), { recursive: true, force: true });
}

/** Without a journal: any drill file still hidden from git goes back to what HEAD has. */
function orphans(root: string, drills: readonly DrillEntry[]): Saved[] {
  const paths = new Set(
    drills.flatMap((drill) => unseal<Fault>(drill.id, drill.sealed).files.map((file) => file.path)),
  );
  return [...paths]
    .filter((path) => existsSync(join(root, path)) && gitTag(root, path) === "S")
    .map((path) => {
      const { atimeMs, mtimeMs } = statSync(join(root, path));
      return { path, original: git(root, ["show", `HEAD:${path}`]), atimeMs, mtimeMs };
    });
}

export async function resetDrill(
  root: string,
  slotSwitch: SlotSwitch,
  deps: DrillDeps,
): Promise<Reset & { ok: boolean }> {
  cleanCheckDir(root);
  let journal: Journal;
  let unreadable = false;
  try {
    journal = readJournal(root);
  } catch {
    journal = { active: null, passed: [] };
    unreadable = true;
  }
  const active = journal.active;
  if (!active) {
    const lost = orphans(root, deps.drills);
    const switched = lost.length ? await swap(slotSwitch, root, () => restoreFiles(root, lost)) : NOTHING_SWITCHED;
    if (unreadable) writeJournal(root, journal);
    return { drill: null, restored: lost.length, undone: 0, failures: [], ...switched, ok: true };
  }
  const fault = unseal<Fault>(active.id, findDrill(deps, active.id).sealed);
  const restored = active.files.length;
  let switched = NOTHING_SWITCHED;
  if (restored) {
    switched = await swap(slotSwitch, root, () => restoreFiles(root, active.files));
    writeJournal(root, { ...journal, active: { ...active, phase: "undoing", files: [] } });
  }
  const failures: string[] = [];
  const live = deps.live(root);
  try {
    for (const action of fault.undo) {
      await live.act(fillAction(action, active.vars)).catch((error: unknown) => failures.push(describe(error)));
    }
  } finally {
    await live.close();
  }
  // A failed undo keeps the journal, so running reset again retries it; every undo is safe to repeat.
  if (failures.length === 0) writeJournal(root, { ...journal, active: null });
  return {
    drill: active.id,
    restored,
    undone: fault.undo.length - failures.length,
    failures,
    ...switched,
    ok: failures.length === 0,
  };
}

export type DrillRow = { id: string; title: string; status: "active" | "passed" | "not_started" };

export function listDrills(root: string, deps: DrillDeps): { drills: DrillRow[]; active: string | null } {
  const journal = readJournal(root);
  const active = journal.active?.id ?? null;
  return {
    active,
    drills: deps.drills.map(({ id, title }) => ({
      id,
      title,
      status: id === active ? "active" : journal.passed.includes(id) ? "passed" : "not_started",
    })),
  };
}

type VitestJson = {
  testResults?: {
    message?: string;
    assertionResults?: { fullName: string; status: string; failureMessages?: string[] }[];
  }[];
};

/**
 * Runs a fault's test against the reference, from `CHECK_DIR` (so the repo's Vitest config and aliases apply),
 * then deletes it. A skipped test fails: it means the database wasn't there, so nothing was checked.
 */
export async function runDrillTest(
  root: string,
  id: string,
  source: string,
  { project, env = localEnv(root) }: { project: string | null; env?: NodeJS.ProcessEnv },
): Promise<DrillTest> {
  const dir = join(root, CHECK_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(CHECK_DIR, `${id}.test.ts`);
  const report = join(tmpdir(), `ex-drill-${process.pid}-${Date.now()}.json`);
  writeFileSync(join(root, file), source);
  try {
    const args = ["run", "--reporter=json", `--outputFile=${report}`, ...(project ? ["--project", project] : []), file];
    const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("VITEST")));
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(join(root, "node_modules/.bin/vitest"), args, {
        cwd: root,
        env: { ...childEnv, AC_ACTIVE_STEP: NO_STEP },
        stdio: "ignore",
      });
      child.on("error", reject);
      child.on("close", (exit) => resolve(exit ?? 1));
    });
    if (!existsSync(report))
      return { passed: false, tests: [], error: `vitest exited with ${code} and wrote no report` };
    const parsed = JSON.parse(readFileSync(report, "utf8")) as VitestJson;
    const results = parsed.testResults ?? [];
    const tests: DrillTestResult[] = results.flatMap((result) =>
      (result.assertionResults ?? []).map((assertion) => ({
        name: assertion.fullName,
        outcome: assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped",
        message: assertion.failureMessages?.length ? assertion.failureMessages.join("\n").split("\n    at ")[0]! : null,
      })),
    );
    // A file that failed to load, or a hook that threw: its tests are skipped, and the reason is the file's.
    const error = results.find((result) => result.message)?.message ?? null;
    const passed = code === 0 && tests.length > 0 && tests.every((test) => test.outcome === "passed");
    return { passed, tests, error: error ? error.split("\n    at ")[0]! : null };
  } finally {
    rmSync(join(root, file), { force: true });
    rmSync(report, { force: true });
  }
}

export function defaultDrillDeps(): DrillDeps {
  return {
    drills: DRILLS,
    // Loaded on use: the live side imports the app's database and model code.
    live: (root) => lazyLive(root),
    runTest: (root, id, source) => runDrillTest(root, id, source, { project: "app" }),
    now: () => new Date(),
  };
}

function lazyLive(root: string): Live {
  let loaded: Promise<Live> | null = null;
  const get = () => (loaded ??= import("./drill-live").then(({ createLive }) => createLive({ env: localEnv(root) })));
  return {
    preflight: async (needs) => (await get()).preflight(needs),
    resolve: async (names, vars) => (await get()).resolve(names, vars),
    count: async (sql) => (await get()).count(sql),
    act: async (action) => (await get()).act(action),
    probe: async (probe) => (await get()).probe(probe),
    close: async () => {
      if (loaded) await (await loaded).close();
    },
  };
}
