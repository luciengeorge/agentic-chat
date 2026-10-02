import { rmSync } from "node:fs";
import { join } from "node:path";

import type { DevServerEntry } from "../../vite-plugins/learn-slots";

import {
  CONTROL_PATH,
  DEV_SERVER_FILE,
  isAlive,
  readActiveStep,
  readDevServerEntry,
} from "../../vite-plugins/learn-slots";
import { ExError } from "./errors";

/** The dev server waits up to 15 s for the requests it let in to answer before the pause does. */
const PAUSE_TIMEOUT_MS = 30_000;
const RESUME_TIMEOUT_MS = 5000;

export type DevServerOptions = {
  /** How long a restart may take, Workflow's build included. */
  restartTimeoutMs?: number;
  pollMs?: number;
  /**
   * How long a live dev server may refuse connections before its entry is forgotten: a restart
   * closes the old listener a moment before the entry says so.
   */
  refusedMs?: number;
};

export type PausedDevServer = {
  /** Requests the dev server let in before the pause that still hadn't answered when it stopped waiting. */
  open: number;
  /** Lifts the pause and restarts the dev server; resolves once a new server serves the active step. */
  restart(): Promise<void>;
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function refused(error: unknown): boolean {
  return (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
}

function explain(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Removes the entry if it still names this server; a newer server's entry stays. */
function forget(root: string, entry: DevServerEntry): null {
  if (readDevServerEntry(root)?.token === entry.token) rmSync(join(root, DEV_SERVER_FILE), { force: true });
  return null;
}

async function post(entry: DevServerEntry, action: "pause" | "resume", timeoutMs: number): Promise<Response> {
  return fetch(`${entry.url}${CONTROL_PATH}/${action}`, {
    method: "POST",
    headers: { "x-ex-token": entry.token, "x-ex-pid": String(process.pid) },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Pauses the dev server that `.ex/dev-server.json` names (vite-plugins/learn-slots.ts), or null when
 * none runs. A server that's restarting is waited for, and the new one is paused: a pause sent to
 * the old one would be lost with it.
 */
export async function pauseDevServer(
  root: string,
  { restartTimeoutMs = 60_000, pollMs = 100, refusedMs = 2000 }: DevServerOptions = {},
): Promise<PausedDevServer | null> {
  const deadline = Date.now() + restartTimeoutMs;
  let refusedSince: number | null = null;
  for (; ; await sleep(pollMs)) {
    const entry = readDevServerEntry(root);
    if (entry === null) return null;
    // Left behind by a dev server that was killed.
    if (!isAlive(entry.pid)) return forget(root, entry);
    const restarting = () => {
      if (Date.now() < deadline) return;
      throw new ExError(
        `the dev server at ${entry.url} was still restarting after ${restartTimeoutMs / 1000} s`,
        "its terminal shows why; wait for it, or stop it, and try again",
      );
    };
    if (entry.state === "restarting") {
      restarting();
      continue;
    }
    let response: Response;
    try {
      response = await post(entry, "pause", PAUSE_TIMEOUT_MS);
    } catch (error) {
      if (!refused(error)) throw new ExError(`couldn't pause the dev server at ${entry.url}`, explain(error));
      refusedSince ??= Date.now();
      if (Date.now() - refusedSince >= refusedMs) return forget(root, entry);
      continue;
    }
    refusedSince = null;
    if (response.status === 409) {
      restarting();
      continue;
    }
    if (!response.ok) {
      const detail = `pause answered ${response.status} ${(await response.text()).trim()}`.trim();
      throw new ExError(`couldn't pause the dev server at ${entry.url}`, detail);
    }
    const { open } = (await response.json()) as { open: number };
    return { open, restart: () => restartDevServer(root, entry, { restartTimeoutMs, pollMs }) };
  }
}

/**
 * Lifts the pause, which restarts the server, then waits for the next server: a new token in
 * `.ex/dev-server.json`, serving the step `.ex/state.json` names.
 */
async function restartDevServer(
  root: string,
  entry: DevServerEntry,
  { restartTimeoutMs, pollMs }: Required<Omit<DevServerOptions, "refusedMs">>,
): Promise<void> {
  const fail = (detail: string) => new ExError(`couldn't restart the dev server at ${entry.url}`, detail);
  let response: Response;
  try {
    response = await post(entry, "resume", RESUME_TIMEOUT_MS);
  } catch (error) {
    throw fail(`${explain(error)}; it restarts on its next request`);
  }
  if (!response.ok) throw fail(`resume answered ${response.status}; it restarts on its next request`);

  const want = readActiveStep(root, {});
  const deadline = Date.now() + restartTimeoutMs;
  for (; ; await sleep(pollMs)) {
    const next = readDevServerEntry(root);
    if (next !== null && next.token !== entry.token && next.state === "running") {
      if (next.step === want) return;
      throw new ExError(
        `the dev server restarted on ${next.step ?? "no step"}, not ${want ?? "no step"}`,
        "is AC_ACTIVE_STEP set where `pnpm dev` runs?",
      );
    }
    if (next?.token === entry.token && next.state === "restart-failed") {
      throw fail("the new server didn't start, so it serves the old code; its terminal shows why");
    }
    if (!isAlive(entry.pid)) throw fail("it exited; start it again with `pnpm dev`");
    if (Date.now() > deadline) {
      throw fail(`no new server after ${restartTimeoutMs / 1000} s; its terminal shows why`);
    }
  }
}
