import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import type { ExError, StepList } from "./steps";

import { ExErrorSchema, StepListSchema } from "./steps";

const run = promisify(execFile);

/** The dev server runs from apps/workshop, and `ex` must run from the repo root. */
const repoRoot = () => process.env.AC_REPO_ROOT ?? path.resolve(process.cwd(), "../..");

export type ExResult<T> = { ok: true; data: T } | { ok: false; error: ExError };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function listSteps(): Promise<ExResult<StepList>> {
  let stdout: string;
  try {
    ({ stdout } = await run("uv", ["run", "ex", "list", "--json"], { cwd: repoRoot(), maxBuffer: 10 * 1024 * 1024 }));
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    const reported = ExErrorSchema.safeParse(parseJson(failure.stdout ?? ""));
    return {
      ok: false,
      error: reported.success
        ? reported.data
        : { error: "ex_failed", detail: failure.stderr?.trim() || failure.message || null },
    };
  }

  const parsed = StepListSchema.safeParse(parseJson(stdout));
  if (!parsed.success) {
    return { ok: false, error: { error: "invalid_ex_output", detail: z.prettifyError(parsed.error) } };
  }
  return { ok: true, data: parsed.data };
}

export async function stepsResponse(): Promise<Response> {
  const result = await listSteps();
  return Response.json(result.ok ? result.data : result.error, {
    status: result.ok ? 200 : 500,
    headers: { "cache-control": "no-store" },
  });
}
