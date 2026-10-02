import { rmSync } from "node:fs";
import { join } from "node:path";

import { CONTROL_PATH, DEV_SERVER_FILE, isAlive, readDevServerEntry } from "../../vite-plugins/learn-slots";
import { ExError } from "./errors";

const TIMEOUT_MS = 5000;

function refused(error: unknown): boolean {
  return (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED";
}

/**
 * Pauses the dev server that `.ex/dev-server.json` names (vite-plugins/learn-slots.ts) and resolves
 * with the function that restarts it, or with null when no dev server runs.
 */
export async function pauseDevServer(root: string): Promise<(() => Promise<void>) | null> {
  const entry = readDevServerEntry(root);
  if (entry === null) return null;
  const forget = () => {
    rmSync(join(root, DEV_SERVER_FILE), { force: true });
    return null;
  };
  // Left behind by a dev server that was killed.
  if (!isAlive(entry.pid)) return forget();

  const post = async (action: "pause" | "resume") => {
    const response = await fetch(`${entry.url}${CONTROL_PATH}/${action}`, {
      method: "POST",
      headers: { "x-ex-token": entry.token, "x-ex-pid": String(process.pid) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${action} answered ${response.status} ${(await response.text()).trim()}`);
  };
  const fail = (action: string, error: unknown) =>
    new ExError(
      `couldn't ${action} the dev server at ${entry.url}`,
      error instanceof Error ? error.message : String(error),
    );

  try {
    await post("pause");
  } catch (error) {
    if (refused(error)) return forget();
    throw fail("pause", error);
  }
  return async () => {
    try {
      await post("resume");
    } catch (error) {
      throw fail("restart", error);
    }
  };
}
