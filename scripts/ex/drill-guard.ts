/**
 * While a drill is planted (section 20), the test suite would give it away: the app's own tests near the faulted
 * file fail, and their names say where it is. So `pnpm test`, `ex test` and `ex gate` refuse until the drill is
 * checked or reset. This file is also a Vitest `globalSetup`, so every run of the repo's config refuses, whatever
 * started it. `ex drill check` runs the fault's own test with `AC_DRILL_CHECK=1`, which lets that one run through.
 */
import type { TestProject } from "vitest/node";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ExError } from "./errors";

export const DRILL_PLANTED = "a drill is planted; the test suite would name its file";
export const DRILL_PLANTED_DETAIL = "Run `pnpm ex drill check` or `pnpm ex drill reset`";

/** True when `.ex/drill.json` holds an active drill, or can't be read (`ex drill reset` repairs that). */
export function drillPlanted(root: string): boolean {
  const path = join(root, ".ex/drill.json");
  if (!existsSync(path)) return false;
  try {
    return Boolean((JSON.parse(readFileSync(path, "utf8")) as { active?: unknown }).active);
  } catch {
    return true;
  }
}

export function refuseWhileDrillPlanted(root: string): void {
  if (drillPlanted(root)) throw new ExError(DRILL_PLANTED, DRILL_PLANTED_DETAIL);
}

export default function setup(project: TestProject): void {
  if (process.env.AC_DRILL_CHECK === "1") return;
  if (drillPlanted(project.config.root)) throw new Error(`${DRILL_PLANTED}. ${DRILL_PLANTED_DETAIL}.`);
}
