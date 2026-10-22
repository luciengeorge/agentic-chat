/**
 * `pnpm ex record`: refreshes the recordings the tests replay (PLAN.md, "Grading with a fake model") by running
 * the recorders the repo has. It says what each would rewrite and roughly what it costs before it calls
 * anything, wants `--yes` before a recorder that calls a paid API, and puts the old files back when a recorder
 * fails or writes something that looks like a key.
 *
 * Most cassettes were recorded once by a script that was never committed; `ex record` lists them and why it
 * can't refresh them.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import type { Run } from "./process";

import { localEnv } from "./env";
import { ExError } from "./errors";
import { run as defaultRun } from "./process";

export type Recorder = {
  name: string;
  title: string;
  /** Run from the repo root. */
  command: string[];
  /** What it rewrites, from the repo root: files, or directories whose files it rewrites. */
  writes: string[];
  /** The paid APIs it calls; empty when it calls none. */
  calls: string[];
  /** Roughly what one run costs. */
  cost: string;
  /** What has to be true before it runs. */
  needs: string[];
  /** What to run afterwards, to grade against the new recording. */
  next: string[];
};

/** A recording made once by a script that isn't in the repo. */
export type Unrecorded = { name: string; files: string[]; why: string };

export type RecordDeps = { recorders: Recorder[]; unrecorded: Unrecorded[]; run?: Run; env?: NodeJS.ProcessEnv };

export const RECORDERS: Recorder[] = [
  {
    name: "eval",
    title: "the faithfulness judge and claim checker on the hand-labelled set",
    command: ["pnpm", "eval:judge", "--record"],
    writes: ["fixtures/cassettes/eval/judge.json", "fixtures/cassettes/eval/claims.json"],
    calls: ["OpenAI (gpt-6-luna)"],
    cost: "about $0.014 (the 2026-10-20 recording)",
    needs: ["OPENAI_API_KEY in .env.local", "MODEL_PROVIDER not set to local"],
    next: ["pnpm test src/core/eval", "pnpm ex gate  # 18.3, 18.4 and 19.3 replay it"],
  },
  {
    name: "vectors",
    title: "the dev database's chunk embeddings and the golden questions' vectors",
    command: ["pnpm", "vectors:record"],
    writes: ["fixtures/vectors/recording", "fixtures/vectors/cache/query-embeddings.json"],
    calls: ["OpenAI embeddings, only for identifiers the query cache lacks (3 at most)"],
    cost: "under $0.0001; the vectors come from the dev database and the query cache",
    needs: [
      "the dev stack up (`pnpm ex up`) and embedded (`pnpm db:embed`)",
      "the query cache filled (`pnpm vectors:bench`)",
      "DATABASE_ADMIN_URL in .env.local",
    ],
    next: ["pnpm test src/components/labs/lexical-server.test.ts", "pnpm ex gate  # sections 06 and 07 replay it"],
  },
  {
    name: "ocr",
    title: "tesseract.js on every corpus page with no text layer",
    command: ["pnpm", "exec", "tsx", "scripts/ocr-record.ts"],
    writes: ["src/core/parse/ocr-recording.json"],
    calls: [],
    cost: "$0: OCR runs on this machine, a minute or so",
    needs: [],
    next: [
      "pnpm test src/core/parse src/core/chunk src/components/labs/parsing-server.test.ts",
      "pnpm ex gate  # section 03 replays it",
    ],
  },
];

const NOT_COMMITTED = "recorded once by a script that isn't committed";

export const UNRECORDED: Unrecorded[] = [
  { name: "model", files: ["fixtures/cassettes/model"], why: `${NOT_COMMITTED} (src/core/model/cassette.ts)` },
  {
    name: "generate",
    files: ["fixtures/cassettes/generate"],
    why: `${NOT_COMMITTED} (src/core/generate/recorded.ts)`,
  },
  { name: "query", files: ["fixtures/cassettes/query"], why: `${NOT_COMMITTED} (src/core/query/recorded.ts)` },
  {
    name: "agent",
    files: ["fixtures/cassettes/agent"],
    why:
      `${NOT_COMMITTED} (src/core/agent/{loop,router,orchestrate}-recorded.ts); ` +
      "runs/ was exported from the dev database (src/core/agent/state-testing.ts)",
  },
  {
    name: "frontend",
    files: ["fixtures/cassettes/frontend"],
    why: "recorded by hand through the dev server, signed in (src/core/frontend/recorded.ts)",
  },
  { name: "local", files: ["fixtures/local/recordings"], why: `${NOT_COMMITTED}, on the vendored local weights` },
];

/** Why `text` can't be committed: it holds a bearer token or an API key. Null when it holds neither. */
export function secretIn(text: string, env: NodeJS.ProcessEnv): string | null {
  if (/Bearer\s/.test(text)) return '"Bearer "';
  for (const name of ["OPENAI_API_KEY", "COHERE_API_KEY"]) {
    const value = env[name]?.trim();
    if (value && value.length >= 8 && text.includes(value)) return `the value of ${name}`;
  }
  if (/\bsk-[\w-]{20,}/.test(text)) return "an OpenAI key (sk-...)";
  return null;
}

/** Every file under `paths` (files, or directories walked whole), by path from the root, with its bytes. */
function snapshot(root: string, paths: string[]): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const add = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) add(join(path, entry));
    } else files.set(relative(root, path), readFileSync(path));
  };
  for (const path of paths) add(join(root, path));
  return files;
}

function restore(root: string, before: Map<string, Buffer>, after: Map<string, Buffer>): void {
  for (const file of after.keys()) if (!before.has(file)) rmSync(join(root, file), { force: true });
  for (const [file, bytes] of before) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
  }
}

export type Recorded = Omit<Recorder, "command"> & {
  command: string;
  status: "planned" | "recorded" | "failed" | "refused" | "not run";
  /** The files the run changed, from the root. */
  changed: string[];
  reason: string | null;
};

export type RecordResult = {
  dry_run: boolean;
  recorders: Recorded[];
  /** The recordings `ex record` can't refresh, and why. */
  unrecorded: Unrecorded[];
  /** What to run next: the selected recorders' `next`, once each. */
  next: string[];
  ok: boolean;
};

/**
 * Plans, and unless `dryRun`, runs the recorders `names` selects (every one for `all`). A recorder that calls a
 * paid API runs only with `yes`. Runs stop at the first that fails or is refused; its files are put back.
 */
export async function record(
  root: string,
  deps: RecordDeps,
  {
    names,
    all,
    dryRun,
    yes,
    capture,
  }: { names: string[]; all: boolean; dryRun: boolean; yes: boolean; capture: boolean },
): Promise<RecordResult> {
  const { recorders, unrecorded, run = defaultRun } = deps;
  for (const name of names) {
    const missing = unrecorded.find((entry) => entry.name === name);
    if (missing) throw new ExError(`ex record can't refresh ${name}: ${missing.why}`);
    if (!recorders.some((recorder) => recorder.name === name)) {
      throw new ExError(
        `no recorder named ${name}`,
        `recorders: ${recorders.map((recorder) => recorder.name).join(", ")}`,
      );
    }
  }
  const listOnly = !all && names.length === 0;
  const selected = listOnly || all ? recorders : recorders.filter((recorder) => names.includes(recorder.name));
  const planned: Recorded[] = selected.map((recorder) => ({
    ...recorder,
    command: recorder.command.join(" "),
    status: "planned",
    changed: [],
    reason: null,
  }));
  const next = [...new Set(selected.flatMap((recorder) => recorder.next))];
  const result = { dry_run: dryRun || listOnly, recorders: planned, unrecorded, next, ok: true };
  if (result.dry_run) return result;

  const paid = selected.filter((recorder) => recorder.calls.length > 0);
  if (paid.length > 0 && !yes) {
    throw new ExError(
      `${paid.map((recorder) => recorder.name).join(" and ")} call${paid.length === 1 ? "s" : ""} paid APIs; ` +
        "run again with --yes to spend it",
      paid.map((recorder) => `${recorder.name}: ${recorder.calls.join(", ")}; ${recorder.cost}`).join("\n"),
    );
  }

  const env = localEnv(root, deps.env ?? process.env);
  for (const [i, recorder] of selected.entries()) {
    const entry = planned[i]!;
    const before = snapshot(root, recorder.writes);
    const [command, ...args] = recorder.command;
    const outcome = await run(command!, args, { cwd: root, env: deps.env ?? process.env, capture });
    const after = snapshot(root, recorder.writes);
    entry.changed = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => !before.get(file)?.equals(after.get(file) ?? Buffer.alloc(0)) || !after.has(file))
      .sort();
    if (outcome.code !== 0) {
      restore(root, before, after);
      const tail = `${outcome.stderr}${outcome.stdout}`.trim().split("\n").slice(-5).join("\n");
      Object.assign(entry, {
        status: "failed",
        changed: [],
        reason: `\`${entry.command}\` exited ${outcome.code}; its files are as they were${tail ? `\n${tail}` : ""}`,
      });
    } else {
      for (const file of entry.changed) {
        const bytes = after.get(file);
        const secret = bytes ? secretIn(bytes.toString("latin1"), env) : null;
        if (!secret) continue;
        restore(root, before, after);
        Object.assign(entry, {
          status: "refused",
          changed: [],
          reason: `${file} holds ${secret}; its files are as they were`,
        });
        break;
      }
      if (entry.status === "planned") entry.status = "recorded";
    }
    if (entry.status !== "recorded") {
      for (const rest of planned.slice(i + 1)) rest.status = "not run";
      return { ...result, ok: false };
    }
  }
  return result;
}

export function recordText(result: RecordResult): string {
  const lines: string[] = [];
  for (const entry of result.recorders) {
    const mark = { planned: "-", recorded: "✓", failed: "✗", refused: "✗", "not run": "-" }[entry.status];
    lines.push(`${mark} ${entry.name.padEnd(8)} ${entry.title}`);
    if (entry.status === "planned") {
      lines.push(`    runs     ${entry.command}`, `    writes   ${entry.writes.join(", ")}`);
      lines.push(`    calls    ${entry.calls.join(", ") || "nothing paid"}`, `    costs    ${entry.cost}`);
      if (entry.needs.length) lines.push(`    needs    ${entry.needs.join("; ")}`);
      lines.push(`    after    ${entry.next.join("; ")}`);
    }
    if (entry.status === "recorded") {
      lines.push(...(entry.changed.length ? entry.changed.map((file) => `    ${file}`) : ["    no file changed"]));
    }
    if (entry.status === "not run") lines.push("    not run: an earlier recorder stopped");
    if (entry.reason) lines.push(...entry.reason.split("\n").map((line) => `    ${line}`));
  }
  if (result.unrecorded.length) {
    lines.push("", "ex record can't refresh these:");
    lines.push(...result.unrecorded.map((entry) => `  ${entry.name.padEnd(8)} ${entry.why}`));
  }
  if (result.dry_run) {
    lines.push("", "Nothing was recorded. `pnpm ex record <name>` or `--all` runs them; paid ones want --yes.");
  } else if (result.ok) {
    lines.push("", "then run:", ...result.next.map((command) => `  ${command}`));
  }
  return lines.join("\n");
}
