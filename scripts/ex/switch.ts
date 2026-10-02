import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Run } from "./process";

import { pauseDevServer } from "./dev-server";
import { ExError } from "./errors";
import { run as defaultRun } from "./process";

/** Cancelling didn't happen, for a reason that's safe to go on with; reported under `skipped`. */
export class CancelSkipped extends Error {
  override name = "CancelSkipped";
}

export type SlotSwitch = {
  /** Stops the running dev server taking work; resolves with how to restart it, or null when none runs. */
  pauseDevServer(root: string): Promise<(() => Promise<void>) | null>;
  /** Cancels every open local workflow run and returns their ids. */
  cancelOpenRuns(root: string): Promise<string[]>;
};

const OPEN_STATUSES = ["pending", "running"] as const;

/**
 * The local world keeps runs as files (`.workflow-data/`, or `WORKFLOW_LOCAL_DATA_DIR`), and the
 * workflow CLI reads and cancels them there, so this works whether or not the dev server runs.
 */
export async function cancelLocalRuns(
  root: string,
  { run = defaultRun, env = process.env }: { run?: Run; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const acEnv = env.AC_ENV ?? "dev";
  if (acEnv !== "dev") throw new CancelSkipped(`AC_ENV is ${acEnv}, not dev`);
  if (!existsSync(resolve(root, env.WORKFLOW_LOCAL_DATA_DIR || ".workflow-data"))) return [];
  const workflowCli = async (args: string[]) => {
    const result = await run(join(root, "node_modules/.bin/workflow"), [...args, "--backend", "local"], {
      cwd: root,
      env,
      capture: true,
    });
    if (result.code !== 0) throw new ExError(`workflow ${args.join(" ")} failed`, result.stderr.trim() || null);
    return result.stdout;
  };
  const listOpen = async () => {
    const open = new Set<string>();
    for (const status of OPEN_STATUSES) {
      let cursor: string | null = null;
      do {
        const args = ["inspect", "runs", "--status", status, "--limit", "100", "--json"];
        const page = JSON.parse(await workflowCli(cursor ? [...args, "--cursor", cursor] : args)) as {
          data: { runId: string }[];
          cursor: string | null;
          hasMore: boolean;
        };
        for (const { runId } of page.data) open.add(runId);
        cursor = page.hasMore ? page.cursor : null;
      } while (cursor);
    }
    return open;
  };

  const cancelled: string[] = [];
  const failures = new Map<string, unknown>();
  for (const runId of await listOpen()) {
    try {
      await workflowCli(["cancel", runId]);
      cancelled.push(runId);
    } catch (error) {
      failures.set(runId, error);
    }
  }
  // Cancelling a run that ended since the listing fails; only a run still open is a failure.
  if (failures.size > 0) {
    const open = await listOpen();
    for (const [runId, error] of failures) if (open.has(runId)) throw error;
  }
  return cancelled;
}

export const defaultSlotSwitch: SlotSwitch = { pauseDevServer, cancelOpenRuns: (root) => cancelLocalRuns(root) };

export type Switched = { files: string[]; restarted: string[]; cancelled: string[]; skipped: string[] };

function describe(error: unknown): string {
  return error instanceof ExError && error.detail ? `${error.message}\n${String(error.detail)}` : String(error);
}

async function cancel(slotSwitch: SlotSwitch, root: string, skipped: string[]): Promise<string[]> {
  try {
    return await slotSwitch.cancelOpenRuns(root);
  } catch (error) {
    if (!(error instanceof CancelSkipped)) {
      throw new ExError("couldn't cancel the open workflow runs, so the step wasn't switched", describe(error));
    }
    skipped.push(`cancel: ${error.message}`);
    return [];
  }
}

/**
 * Swaps the slotted code with nothing running on it (PLAN.md, "Slots"). A run replays its code from
 * its event log, so new code under an open run can break the replay. So: pause the dev server, cancel
 * the open runs, swap the files, and restart the dev server on the new code. A failed pause or cancel
 * leaves the files as they were, and the dev server restarts on the old code.
 */
export async function switchSlots(slotSwitch: SlotSwitch, root: string, swap: () => string[]): Promise<Switched> {
  const skipped: string[] = [];
  let restart: (() => Promise<void>) | null;
  try {
    restart = await slotSwitch.pauseDevServer(root);
  } catch (error) {
    throw new ExError("couldn't pause the dev server, so the step wasn't switched", describe(error));
  }
  let switched: Omit<Switched, "restarted">;
  try {
    const cancelled = await cancel(slotSwitch, root, skipped);
    switched = { files: swap(), cancelled, skipped };
  } catch (error) {
    // If this fails too, the dev server lifts the pause itself once this process has exited.
    await restart?.().catch(() => {});
    throw error;
  }
  const restarted: string[] = [];
  if (restart) {
    try {
      await restart();
      restarted.push("dev server");
    } catch (error) {
      skipped.push(`restart: ${describe(error).replace("\n", ": ")}; it restarts on its next request`);
    }
  }
  return { ...switched, restarted };
}
