/** Marks a progress line on `vitest-run.ts`'s stdout, apart from anything a test prints. */
export const PROGRESS_PREFIX = "@@ex-progress ";

export type RawProgress =
  | { collected: { file: string; name: string }[] }
  | { file: string; name: string; state: string; duration_ms: number; message: string | null };

/** Splits stdout into whole lines as chunks arrive, and hands on the progress lines, parsed. */
export function progressLines(onEvent: (event: RawProgress) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      if (line.startsWith(PROGRESS_PREFIX)) onEvent(JSON.parse(line.slice(PROGRESS_PREFIX.length)) as RawProgress);
    }
  };
}
