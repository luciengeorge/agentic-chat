/**
 * The workshop's server side. It reads the course with `ex`'s own functions (scripts/ex), and runs every command
 * that changes something (start, reset, solution, test, diff) as `pnpm ex <command> --json` in a child process,
 * so the logic stays in one place and a switch pauses and restarts this dev server exactly as it does from a
 * terminal. Dev only: the routes refuse anywhere else.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SectionRow, StepRow } from "../../../scripts/ex/list";
import type { StepRun, Target, TestProgress } from "../../../scripts/ex/testing";
import type { FileDiff } from "../../../scripts/ex/workspace";

import { codeFiles, findStep, loadCatalog } from "../../../scripts/ex/catalog";
import { listSections, nextFor } from "../../../scripts/ex/list";
import { parseHints, type Hint } from "./hints";

export type { FileDiff, SectionRow, StepRow, StepRun, Target, TestProgress };

export const TARGETS = ["playground", "problem", "solution"] as const satisfies readonly Target[];

/** What `ex --json` prints when a command fails, with its detail as text. */
export type ExFailure = { error: string; detail: string | null };

export type Course = { sections: SectionRow[]; active: string | null; passed: number; total: number };

export function readCourse(root: string): Course {
  const sections = listSections(root);
  const steps = sections.flatMap((section) => section.steps);
  return {
    sections,
    active: steps.find((step) => step.status === "active")?.id ?? null,
    passed: steps.filter((step) => step.passed).length,
    total: steps.filter((step) => step.type === "graded").length,
  };
}

/** A markdown file's text without its YAML frontmatter, or null when there's no such file. */
export function readMarkdown(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
    .trim();
}

export function readFrontDoor(root: string): string {
  return readMarkdown(join(root, "exercises/README.md")) ?? "";
}

type StepLink = { id: string; title: string };

export type StepPage = {
  step: StepRow;
  section: { id: string; title: string };
  readme: string;
  hints: Hint[];
  /** The files `ex start` copies into playground/. */
  files: string[];
  /** The section's lab, as a path in this app. */
  lab: string | null;
  previous: StepLink | null;
  next: StepLink | null;
};

export function readStepPage(root: string, stepId: string): StepPage | null {
  const sections = listSections(root);
  const order = sections.flatMap((section) => section.steps.map((step) => ({ section, step })));
  const at = order.findIndex(({ step }) => step.id === stepId);
  if (at === -1) return null;
  const { section, step } = order[at]!;
  const found = findStep(root, stepId);
  const files = codeFiles(found.problemDir);
  const link = (i: number) => (order[i] ? { id: order[i].step.id, title: order[i].step.title } : null);
  const lab = nextFor(root, found).lab;
  return {
    step,
    section: { id: section.id, title: section.title },
    readme: readMarkdown(join(found.problemDir, "README.md")) ?? "",
    hints: files.flatMap((file) => parseHints(file, readFileSync(join(found.problemDir, file), "utf8"))),
    files,
    lab: lab ? new URL(lab).pathname : null,
    previous: link(at - 1),
    next: link(at + 1),
  };
}

export type SectionPage = { section: SectionRow; readme: string; finished: string | null };

export function readSectionPage(root: string, sectionId: string): SectionPage | null {
  const section = listSections(root).find((candidate) => candidate.id === sectionId);
  const dir = loadCatalog(root).find((candidate) => candidate.id === sectionId)?.steps[0]?.problemDir;
  if (!section || !dir) return null;
  const sectionDir = dirname(dir);
  return {
    section,
    readme: readMarkdown(join(sectionDir, "README.md")) ?? "",
    finished: readMarkdown(join(sectionDir, "FINISHED.md")),
  };
}

/** A finished `pnpm ex` run: its exit code, and the JSON it printed (a payload, or an `ExFailure`). */
export type ExOutcome = { code: number; json: unknown };

export type ExRunner = (
  args: string[],
  options?: { onStderrLine?: (line: string) => void; signal?: AbortSignal },
) => Promise<ExOutcome>;

/**
 * Runs `pnpm --silent ex <args> --json` in `root`. The child gets a process group of its own, so an abort stops
 * the whole tree (pnpm, ex, and the Vitest it starts) and nothing else.
 */
export function exRunner(root: string, env: NodeJS.ProcessEnv = process.env): ExRunner {
  return (args, { onStderrLine, signal } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn("pnpm", ["--silent", "ex", ...args, "--json"], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let partial = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
        const lines = (partial + chunk).split("\n");
        partial = lines.pop()!;
        for (const line of lines) onStderrLine?.(line);
      });
      const stop = () => {
        try {
          process.kill(-child.pid!, "SIGTERM");
        } catch {
          // already gone
        }
      };
      signal?.addEventListener("abort", stop, { once: true });
      child.on("error", reject);
      child.on("close", (code) => {
        signal?.removeEventListener("abort", stop);
        let json: unknown;
        try {
          json = JSON.parse(stdout);
        } catch {
          const tail = `${stdout}${stderr}`.trim().split("\n").slice(-20).join("\n");
          json = { error: `\`pnpm ex ${args.join(" ")}\` printed no JSON`, detail: tail || null } satisfies ExFailure;
        }
        resolve({ code: code ?? 1, json });
      });
    });
}

/** The failure `ex` printed, if it printed one. */
export function failureOf(json: unknown): ExFailure | null {
  if (typeof json !== "object" || json === null || !("error" in json) || typeof json.error !== "string") return null;
  const detail = "detail" in json ? json.detail : null;
  return {
    error: json.error,
    detail:
      detail === null || detail === undefined
        ? null
        : typeof detail === "string"
          ? detail
          : JSON.stringify(detail, null, 2),
  };
}

/**
 * One `ex` command that changes the playground or grades it at a time, from this server: two swaps at once would
 * race, and a test run during a swap would grade files mid-copy. Kept on globalThis, because a step switch
 * restarts the dev server, which loads this module afresh, while the child it started runs on.
 */
type Registry = { busy: string | null; jobs: Map<string, SwapJob> };
const REGISTRY = Symbol.for("agentic-chat.workshop");
const registry = ((globalThis as Record<symbol, Registry | undefined>)[REGISTRY] ??= {
  busy: null,
  jobs: new Map(),
});

export class WorkshopBusy extends Error {
  override name = "WorkshopBusy";
}

function claim(what: string): () => void {
  if (registry.busy) throw new WorkshopBusy(`${registry.busy}. Wait for it to finish, then try again.`);
  registry.busy = what;
  return () => {
    registry.busy = null;
  };
}

export const SWAPS = ["start", "reset", "solution"] as const;
export type SwapCommand = (typeof SWAPS)[number];

export type SwapJob = {
  id: string;
  /** The user who started it: only they can poll it. */
  owner: string;
  command: SwapCommand;
  step: string;
  force: boolean;
  state: "running" | "done" | "failed";
  /** The payload `ex` printed when it worked. */
  result: unknown;
  error: ExFailure | null;
  /** `ex start` refused because playground/ holds changes it would discard; `--force` would go ahead. */
  wouldDiscard: boolean;
  startedAt: string;
  finishedAt: string | null;
};

const JOBS_KEPT = 20;

/**
 * Starts `ex start|reset|solution` and returns at once, before `ex` pauses this server: the pause waits for the
 * requests already in flight to answer, and this one is among them. The caller polls `getSwapJob`.
 */
export function startSwap(
  run: ExRunner,
  { command, step, force = false, owner }: { command: SwapCommand; step: string; force?: boolean; owner: string },
): SwapJob {
  const release = claim(`\`ex ${command} ${step}\` is still running`);
  const job: SwapJob = {
    id: randomUUID(),
    owner,
    command,
    step,
    force,
    state: "running",
    result: null,
    error: null,
    wouldDiscard: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  registry.jobs.set(job.id, job);
  for (const id of [...registry.jobs.keys()].slice(0, -JOBS_KEPT)) registry.jobs.delete(id);
  const args = [command, step, ...(command === "start" && force ? ["--force"] : [])];
  void run(args)
    .then(({ code, json }) => {
      const failure = failureOf(json);
      if (code === 0 && !failure) {
        job.state = "done";
        job.result = json;
        return;
      }
      job.state = "failed";
      job.error = failure ?? { error: `\`pnpm ex ${args.join(" ")}\` failed`, detail: null };
      job.wouldDiscard = /would discard/.test(job.error.error);
    })
    .catch((error: unknown) => {
      job.state = "failed";
      job.error = { error: error instanceof Error ? error.message : String(error), detail: null };
    })
    .finally(() => {
      job.finishedAt = new Date().toISOString();
      release();
    });
  return job;
}

export function getSwapJob(id: string, owner: string): SwapJob | null {
  const job = registry.jobs.get(id);
  return job && job.owner === owner ? job : null;
}

/** What a test run streams: the tests as they're collected and finish, then the whole run, or why it couldn't run. */
export type TestEvent =
  | { type: "started"; step: string; target: Target }
  | TestProgressEvent
  | { type: "done"; run: StepRun }
  | { type: "failed"; error: ExFailure };
type TestProgressEvent = { type: "collected"; nodeids: string[] } | { type: "test"; test: StepRun["tests"][number] };

function progressEvent(line: string): TestProgressEvent | null {
  let parsed: TestProgress;
  try {
    parsed = JSON.parse(line) as TestProgress;
  } catch {
    return null; // pnpm or Node printing something of its own
  }
  if (parsed?.event === "collected") return { type: "collected", nodeids: parsed.nodeids };
  if (parsed?.event === "test") return { type: "test", test: parsed.test };
  return null;
}

/** Runs `ex test <step> --target <target> --progress`, passing each event on as it comes. */
export async function runTests(
  run: ExRunner,
  {
    step,
    target,
    signal,
    emit,
  }: { step: string; target: Target; signal?: AbortSignal; emit: (event: TestEvent) => void },
): Promise<void> {
  const release = claim(`The tests for ${step} are running`);
  try {
    emit({ type: "started", step, target });
    const { json } = await run(["test", step, "--target", target, "--progress"], {
      signal,
      onStderrLine: (line) => {
        const event = progressEvent(line);
        if (event) emit(event);
      },
    });
    if (signal?.aborted) return;
    const failure = failureOf(json);
    if (failure) emit({ type: "failed", error: failure });
    else emit({ type: "done", run: json as StepRun });
  } finally {
    release();
  }
}

export type DiffResult = { files: FileDiff[] } | ExFailure;

export async function readDiff(run: ExRunner, step: string): Promise<DiffResult> {
  const { json } = await run(["diff", step]);
  return failureOf(json) ?? { files: (json as { files: FileDiff[] }).files };
}

/**
 * A test run as server-sent events: each `TestEvent` as a `data:` line, and a comment every `heartbeatMs` so a
 * long, quiet run (Vitest starting up, a slow database test) doesn't look dead to a proxy or the browser. The run
 * stops when the client goes away (`signal`) or cancels the stream.
 */
export function testEventStream(
  run: ExRunner,
  {
    step,
    target,
    signal,
    heartbeatMs = 15_000,
  }: { step: string; target: Target; signal: AbortSignal; heartbeatMs?: number },
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  signal.addEventListener("abort", () => abort.abort(), { once: true });
  let closed = false;
  return new ReadableStream({
    start(controller) {
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      const beat = setInterval(() => write(": keep-alive\n\n"), heartbeatMs);
      const emit = (event: TestEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
      runTests(run, { step, target, signal: abort.signal, emit })
        .catch((error: unknown) =>
          emit({
            type: "failed",
            error: { error: error instanceof Error ? error.message : String(error), detail: null },
          }),
        )
        .finally(() => {
          clearInterval(beat);
          if (closed) return;
          closed = true;
          controller.close();
        });
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });
}
