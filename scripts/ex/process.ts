import { spawn } from "node:child_process";

import { ExError } from "./errors";

export type RunResult = { code: number; stdout: string; stderr: string };
/** `onStdout` sees captured output as it arrives. */
export type RunOptions = { cwd: string; env?: NodeJS.ProcessEnv; capture: boolean; onStdout?: (text: string) => void };
export type Run = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Runs a command to completion. Without `capture` it shares this terminal and returns empty output. */
export const run: Run = (command, args, { cwd, env, capture, onStdout }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "";
    let stderr = "";
    // As text, so a character split across two chunks arrives whole.
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      onStdout?.(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new ExError(`${command} is not on PATH`) : error),
    );
    child.on("close", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), stdout, stderr }));
  });
