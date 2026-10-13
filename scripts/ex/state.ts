import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { STATE_FILE } from "../../vite-plugins/learn-slots";
import { ExError } from "./errors";

export type State = { activeStep: string | null; passed: string[] };

export function readState(root: string): State {
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) return { activeStep: null, passed: [] };
  let data: { active_step?: unknown; passed?: unknown } | null;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ExError(`${STATE_FILE} isn't valid JSON`, `delete it and run \`pnpm ex start <step>\``);
  }
  const active = data?.active_step;
  const passed = Array.isArray(data?.passed) ? data.passed : [];
  return {
    activeStep: typeof active === "string" && active ? active : null,
    passed: passed.filter((step): step is string => typeof step === "string"),
  };
}

export function writeState(root: string, state: State): void {
  const path = join(root, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const body = { active_step: state.activeStep, passed: [...new Set(state.passed)].sort() };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}
