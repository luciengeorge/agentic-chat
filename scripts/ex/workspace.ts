import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Step } from "./catalog";

import { codeFiles, stepFiles } from "./catalog";
import { ExError } from "./errors";
import { readState, writeState } from "./state";

export const PLAYGROUND = "playground";

export function playground(root: string): string {
  return join(root, PLAYGROUND);
}

export function requireActive(root: string, step: Step): void {
  const active = readState(root).activeStep;
  if (active !== step.id) {
    throw new ExError(
      `step ${step.id} isn't active (active: ${active ?? "none"})`,
      `run \`pnpm ex start ${step.id}\` first`,
    );
  }
}

/**
 * Makes playground/ hold exactly the step's code files from `source`, flat. Tests aren't copied:
 * `ex test` runs them from the problem dir, so editing a copy can't change the grade. Files are
 * overwritten in place, so a running dev server sees a change rather than a delete and an add.
 */
export function fillPlayground(root: string, source: string): string[] {
  const target = playground(root);
  const files = codeFiles(source);
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(target)) {
    if (!files.includes(name)) rmSync(join(target, name), { recursive: true, force: true });
  }
  for (const name of files) copyFileSync(join(source, name), join(target, name));
  return files;
}

function snapshot(dir: string, names: string[]): Map<string, string> {
  return new Map(names.map((name) => [name, readFileSync(join(dir, name), "utf8")]));
}

function sameFiles(a: Map<string, string>, b: Map<string, string>): boolean {
  return a.size === b.size && [...a].every(([name, text]) => b.get(name) === text);
}

/** Whether playground/ holds work that matches neither the step's problem code nor its solution. */
export function hasChanges(root: string, step: Step): boolean {
  const ours = playground(root);
  if (!existsSync(ours)) return false;
  if (readdirSync(ours, { withFileTypes: true }).some((entry) => !entry.isFile() && entry.name !== ".DS_Store")) {
    return true;
  }
  const current = snapshot(ours, stepFiles(ours));
  return [step.problemDir, step.solutionDir].every((dir) => !sameFiles(current, snapshot(dir, codeFiles(dir))));
}

export function activate(root: string, step: Step): string[] {
  const files = fillPlayground(root, step.problemDir);
  writeState(root, { ...readState(root), activeStep: step.id });
  return files;
}

export function markPassed(root: string, step: Step): void {
  const state = readState(root);
  writeState(root, { ...state, passed: [...state.passed, step.id] });
}

export type FileDiff = { path: string; changed: boolean; diff: string };

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Playground against the solution, one entry per code file in either. */
export function diffPlayground(root: string, step: Step): FileDiff[] {
  const ours = playground(root);
  const names = [...new Set([...codeFiles(step.solutionDir), ...codeFiles(ours)])].sort();
  return names.map((name) => {
    const mine = read(join(ours, name));
    const theirs = read(join(step.solutionDir, name));
    const diff =
      mine === theirs
        ? ""
        : createTwoFilesPatch(`playground/${name}`, `solution/${name}`, mine, theirs, undefined, undefined, {
            headerOptions: FILE_HEADERS_ONLY,
          });
    return { path: name, changed: diff !== "", diff };
  });
}
